
suppressPackageStartupMessages({
  here <- dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE)))
  .libPaths(c(file.path(normalizePath(here), "rlib"), .libPaths()))
  library(jsonlite)
  library(foreach)
  library(magrittr)
  library(rELA)
})

args <- commandArgs(TRUE)
if (length(args) < 2 || any(startsWith(args[1:2], "--")))
  stop("usage: run_ela.R <input.json> <result.json> [options]")
positional <- args[1:2]
opt <- function(name, default) {
  i <- match(paste0("--", name), args)
  if (is.na(i)) default else as.numeric(args[i + 1])
}
opt_str <- function(name, default) {
  i <- match(paste0("--", name), args)
  if (is.na(i)) default else args[i + 1]
}
env_keys <- opt_str("env", "")
env_keys <- if (env_keys == "") character(0) else strsplit(env_keys, ",")[[1]]
P <- list(
  seed    = opt("seed", 20260824),
  ath     = opt("ath", 0.02),
  minoc   = opt("minoc", 0.05),
  maxoc   = opt("maxoc", 0.95),
  nmax    = opt("nmax", 20),
  rep     = opt("rep", 128),
  totalit = opt("totalit", 1000),
  boot    = opt("boot", 50),
  shuffle = as.numeric("--shuffle" %in% args)
)

inp <- fromJSON(positional[1])
ab <- inp$abundance
rownames(ab) <- inp$samples
colnames(ab) <- inp$asvs
dates <- inp$dates

nz <- rowSums(ab) > 0
dropped_empty <- rownames(ab)[!nz]
ab <- ab[nz, , drop = FALSE]
dates <- dates[nz]

enmat <- NULL
env_scaling <- NULL
n_dropped_env <- 0
if (length(env_keys)) {
  fehlt <- setdiff(env_keys, names(inp$environment))
  if (length(fehlt)) stop("environment variable(s) not in the input: ", paste(fehlt, collapse = ", "))
  raw <- sapply(env_keys, function(k) as.numeric(inp$environment[[k]]))
  raw <- raw[nz, , drop = FALSE]
  ok <- rowSums(is.na(raw)) == 0
  n_dropped_env <- sum(!ok)
  ab <- ab[ok, , drop = FALSE]
  dates <- dates[ok]
  raw <- raw[ok, , drop = FALSE]
  env_scaling <- lapply(seq_along(env_keys), function(j)
    list(key = env_keys[j], min = min(raw[, j]), max = max(raw[, j])))
  enmat <- apply(raw, 2, function(x) (x - min(x)) / (max(x) - min(x)))
  colnames(enmat) <- env_keys
}

set.seed(P$seed)

meta <- if (is.null(enmat)) NULL else as.data.frame(enmat, row.names = rownames(ab))
fmt <- Formatting(as.data.frame(ab), meta, 1, c(P$ath, P$minoc, P$maxoc), reporting = FALSE)
ocmat <- as.matrix(fmt[[1]])
survivors <- colnames(ocmat)
if (!is.null(enmat)) {
  enmat <- as.matrix(fmt[[3]])
  dates <- dates[match(rownames(ocmat), rownames(ab))]
}

if (P$shuffle == 1) {
  ocmat <- apply(ocmat, 2, function(col) col[sample.int(length(col))])
  rownames(ocmat) <- fmt[[4]]
}

dropped <- character(0)
if (ncol(ocmat) > P$nmax) {
  p <- colMeans(ocmat)
  score <- p * (1 - p)
  keep <- colnames(ocmat)[order(-score, colnames(ocmat))][1:P$nmax]
  keep <- sort(keep)
  dropped <- setdiff(colnames(ocmat), keep)
  ocmat <- ocmat[, keep]
}

chains <- runSA(ocmat, enmat = enmat, rep = P$rep, threads = 1, totalit = P$totalit,
                getall = TRUE, reporting = FALSE)
sa <- list(saEndpoint(chains, ocmat, enmat = enmat), enmat)

landscape <- function(sa_obj, envpt) {
  elanp <- ELA(sa_obj, env = envpt, threads = 1, reporting = FALSE, fork = FALSE)
  ela <- ELPruning(elanp, th = 0.05, threads = 1, reporting = FALSE, fork = FALSE)
  ss <- sstable(ela[[1]], ocmat)
  tp <- tptable(ela[[1]], ocmat)
  states <- lapply(seq_len(nrow(ss)), function(i) list(
    id = as.character(ss$ID[i]),
    energy = as.numeric(as.character(ss$Energy[i])),
    active = colnames(ocmat)[as.numeric(as.character(unlist(ss[i, -(1:2)]))) == 1]
  ))
  states <- states[order(vapply(states, function(s) s$energy, 0))]
  tippings <- if (is.null(tp)) list() else {
    s1 <- as.character(tp$SS1); s2 <- as.character(tp$SS2)
    e  <- as.numeric(as.character(tp$Energy))
    ids <- unique(c(s1, s2))
    D <- matrix(Inf, length(ids), length(ids), dimnames = list(ids, ids))
    for (i in seq_along(e)) D[s1[i], s2[i]] <- D[s2[i], s1[i]] <- min(D[s1[i], s2[i]], e[i])
    for (k in ids) D <- pmin(D, pmax(outer(D[, k], rep(1, length(ids))),
                                     outer(rep(1, length(ids)), D[k, ])))
    lapply(seq_along(e), function(i) list(
      ss1 = s1[i], ss2 = s2[i], energy = D[s1[i], s2[i]], rela_path_energy = e[i]))
  }
  list(states = states, tippings = tippings)
}

recurrence <- function(states, envpt) {
  recur <- setNames(numeric(length(states)), vapply(states, function(s) s$id, ""))
  if (P$boot > 0 && length(states) > 0) {
    for (b in seq_len(P$boot)) {
      bsa <- list(saEndpoint(chains[sample.int(length(chains), replace = TRUE)],
                             ocmat, enmat = enmat), enmat)
      bela <- ELPruning(ELA(bsa, env = envpt, threads = 1, reporting = FALSE, fork = FALSE),
                        th = 0.05, threads = 1, reporting = FALSE, fork = FALSE)
      bids <- as.character(sstable(bela[[1]], ocmat)$ID)
      hit <- names(recur) %in% bids
      recur[hit] <- recur[hit] + 1
    }
    recur <- recur / P$boot
  }
  recur
}

if (is.null(enmat)) {
  base <- landscape(sa, NULL)
  states <- base$states
  tippings <- base$tippings
  recur <- recurrence(states, NULL)
  env_block <- NULL
  hge <- sa[[1]][, 1]
  je  <- sa[[1]][, 2:ncol(sa[[1]]), drop = FALSE]
  observed <- lapply(seq_len(nrow(ocmat)), function(i) {
    zu <- Bi(ocmat[i, ], hge, je)
    out <- list(sample = rownames(ocmat)[i],
                energy = Energy(ocmat[i, ], hge, je),
                basin = zu[[1]])
    if (!is.null(inp$dates)) out$date <- inp$dates[match(rownames(ocmat)[i], inp$samples)]
    out
  })
} else {
  months <- as.integer(substring(dates, 6, 7))
  punkte <- list(
    list(name = "median", months = NULL, rows = rep(TRUE, nrow(enmat))),
    list(name = "winter", months = c(12, 1, 2), rows = months %in% c(12, 1, 2)),
    list(name = "summer", months = c(6, 7, 8), rows = months %in% c(6, 7, 8))
  )
  eval_points <- list()
  states <- list(); tippings <- list(); recur <- list()
  for (pkt in punkte) {
    if (!any(pkt$rows)) next
    envpt <- if (pkt$name == "median") apply(enmat, 2, median)
             else colMeans(enmat[pkt$rows, , drop = FALSE])
    l <- landscape(sa, envpt)
    eval_points[[length(eval_points) + 1]] <- list(
      name = pkt$name,
      months = if (is.null(pkt$months)) "all" else pkt$months,
      n_samples_in_window = sum(pkt$rows),
      env_scaled = as.list(round(envpt, 6)),
      n_stable_states = length(l$states),
      stable_states = l$states,
      tipping_points = l$tippings,
      state_recurrence = as.list(recurrence(l$states, envpt))
    )
  }
  env_block <- list(
    covariates = env_keys,
    scaling = env_scaling,
    scaling_note = "each variable scaled linearly to [0,1] (min/max above); evaluation points in the scaled space",
    n_samples_dropped_missing_env = n_dropped_env,
    eval_points = eval_points
  )
}

result <- list(
  dataset_id = inp$dataset_id,
  level = if (is.null(inp$level)) "asv" else inp$level,
  mode = if (is.null(enmat)) "base" else "environment",
  value_kind = inp$value_kind,
  parameters = P,
  preprocessing = list(
    method = if (identical(inp$level, "cluster"))
      "rELA::Formatting(normalize=1) -- share of the network-ASV subtotal of the sample (sum of the cluster columns, not the sample total) >= ath becomes 1, prevalence window minoc..maxoc"
    else "rELA::Formatting(normalize=1) -- relative abundance >= ath becomes 1, prevalence window minoc..maxoc",
    n_samples_input = length(inp$samples),
    n_samples_dropped_empty = length(dropped_empty),
    samples_dropped_empty = I(dropped_empty),
    empty_rule = "samples whose row in the input matrix sums to 0 are not observations and are removed before Formatting",
    n_species_input = ncol(ab),
    n_species_after_formatting = length(survivors),
    n_species_model = ncol(ocmat),
    species = colnames(ocmat),
    prevalence = as.list(setNames(round(colMeans(ocmat), 4), colnames(ocmat))),
    dropped_by_cap = dropped,
    cap_rule = "top nmax by p(1-p) of the binarised column"
  ),
  n_stable_states = if (is.null(enmat)) length(states) else NULL,
  stable_states = if (is.null(enmat)) states else NULL,
  tipping_points = if (is.null(enmat)) tippings else NULL,
  observed_communities = if (is.null(enmat)) list(
    method = paste0("rELA::Energy per binarised sample; basin assignment rELA::Bi ",
                    "(steepest descent). Figure style after Oldenburg et al. 2024, Fig. 5 ",
                    "(energy of observed communities over time)."),
    samples = observed
  ) else NULL,
  fitted_parameters = if (is.null(enmat)) list(
    note = paste0("saEndpoint mean of the SA chains; E(sigma) = -sigma.h - ",
                  "sigma.J.sigma/2 (rELA cEnergy) -- for independent recomputation"),
    species = colnames(ocmat),
    h = as.numeric(hge),
    J = unname(je)
  ) else NULL,
  environment_model = env_block,
  bootstrap = list(
    method = "SA chains resampled with replacement, per resample saEndpoint -> ELA -> pruning",
    iterations = P$boot,
    state_recurrence = if (is.null(enmat)) as.list(recur) else
      "per evaluation point, see environment_model.eval_points"
  ),
  provenance = list(
    tool = paste0("rELA ", as.character(packageVersion("rELA")), " (vendored, commit 9408106)"),
    model = if (is.null(enmat)) "pairwise maximum-entropy model without environmental covariates"
            else "extended pairwise maximum-entropy model with environmental covariates (fullSA)",
    reference = "Suzuki et al. 2021, Ecological Monographs 91(3):e01469",
    input_file = basename(positional[1]),
    shuffled_null = P$shuffle == 1
  )
)

result <- result[!vapply(result, is.null, TRUE)]
writeLines(toJSON(result, auto_unbox = TRUE, digits = 10, pretty = TRUE), positional[2])
zusammenfassung <- if (is.null(enmat)) {
  sprintf("%d stable states", length(states))
} else {
  sprintf("%d evaluation points", length(env_block$eval_points))
}
cat(sprintf("%s: %d columns in the model, %s -> %s\n",
            inp$dataset_id, ncol(ocmat), zusammenfassung, positional[2]))
