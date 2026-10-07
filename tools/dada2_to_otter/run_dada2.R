
invisible(Sys.setLanguage("en"))

args  <- commandArgs(trailingOnly = TRUE)
if (any(args %in% c("-h", "--help"))) {
  cat(paste(
    "usage: Rscript run_dada2.R FASTQ_DIR OUT_DIR [TOP_N]",
    "",
    "Runs cutadapt and DADA2 on gzipped paired-end Illumina reads and writes the files that",
    "convert.py turns into otter's input tables.",
    "",
    "  FASTQ_DIR  <sample>_S<n>_L001_R1_001.fastq.gz and the matching _R2_001.fastq.gz files;",
    "             the sample name is the part before _S<n>_L001",
    "  OUT_DIR    output folder, created if missing; intermediate files and the resume caches",
    "             go to OUT_DIR/tmp (a rerun into the same OUT_DIR skips the finished DADA2 steps)",
    "  TOP_N      keep the N ASVs with the most reads (default 500, or MANTA_TOP_N)",
    "",
    "Environment variables:",
    "  MANTA_METADATA     metadata.csv with the real sampling dates: ';'-separated, columns",
    "                     'sample' and 'date', dates as YYYY-MM-DD, one row per sample; checked",
    "                     before DADA2 starts. Without it the samples get placeholder dates that",
    "                     only encode their order, marked by OUT_DIR/placeholder_dates.txt.",
    "  MANTA_PR2          PR2 reference in DADA2 format for assignTaxonomy; empty = no taxonomy,",
    "                     the ASVs stay 'unassigned'",
    "  MANTA_NCORES       threads (default 4)",
    "  MANTA_FWD_PRIMER   forward primer (default GCGGTAATTCCAGCTCCAA)",
    "  MANTA_REV_PRIMER   reverse primer (default ACTTTCGTTCTTGATYRR)",
    "  MANTA_TRUNC_F / MANTA_TRUNC_R       truncLen (default 260 / 210)",
    "  MANTA_MAXEE_F / MANTA_MAXEE_R       maxEE (default 2.6 / 2.1)",
    "  MANTA_MIN_OVERLAP  minOverlap for mergePairs (default 15)",
    "  MANTA_ASV_PREFIX   ASV name prefix (default asv)",
    "  MANTA_KINGDOM      Kingdom label when there is no taxonomy (default unassigned)",
    "", sep = "\n"))
  quit(save = "no", status = 0)
}

suppressMessages({ library(dada2); library(Biostrings); library(ShortRead) })

src   <- if (length(args) >= 1) args[1] else stop("usage: Rscript run_dada2.R FASTQ_DIR OUT_DIR [TOP_N]")
out   <- if (length(args) >= 2) args[2] else stop("usage: Rscript run_dada2.R FASTQ_DIR OUT_DIR [TOP_N]")
TOP_N <- if (length(args) >= 3) as.integer(args[3]) else as.integer(Sys.getenv("MANTA_TOP_N", "500"))
NCORES <- as.integer(Sys.getenv("MANTA_NCORES", "4"))
PR2 <- Sys.getenv("MANTA_PR2", "")
HAS_TAX <- nzchar(PR2) && file.exists(PR2)
FWD_PRIMER <- Sys.getenv("MANTA_FWD_PRIMER", "GCGGTAATTCCAGCTCCAA")
REV_PRIMER <- Sys.getenv("MANTA_REV_PRIMER", "ACTTTCGTTCTTGATYRR")
TRUNC_F <- as.integer(Sys.getenv("MANTA_TRUNC_F", "260"))
TRUNC_R <- as.integer(Sys.getenv("MANTA_TRUNC_R", "210"))
MAXEE_F <- as.numeric(Sys.getenv("MANTA_MAXEE_F", "2.60"))
MAXEE_R <- as.numeric(Sys.getenv("MANTA_MAXEE_R", "2.10"))
MIN_OVERLAP <- as.integer(Sys.getenv("MANTA_MIN_OVERLAP", "15"))
META_IN <- Sys.getenv("MANTA_METADATA", "")
PLACEHOLDER_DATES <- "placeholder_dates.txt"
KINGDOM <- Sys.getenv("MANTA_KINGDOM", "unassigned")
cat("Cores:", NCORES, "· taxonomy:", if (HAS_TAX) PR2 else "OFF (ASVs stay unassigned)", "\n")
if (nzchar(PR2) && !HAS_TAX)
  message("WARNING: MANTA_PR2 is set, but the file does not exist: ", PR2, " - taxonomy is skipped")

split_csv_line <- function(line) {
  ch <- strsplit(line, "", fixed = TRUE)[[1]]
  fields <- character(0); cur <- character(0); inq <- FALSE; start <- TRUE; i <- 1L
  while (i <= length(ch)) {
    c1 <- ch[i]
    if (inq) {
      if (c1 == "\"") {
        if (i < length(ch) && ch[i + 1L] == "\"") { cur <- c(cur, "\""); i <- i + 1L } else inq <- FALSE
      } else cur <- c(cur, c1)
    } else if (start && c1 == "\"") {
      inq <- TRUE; start <- FALSE
    } else if (c1 == ";") {
      fields <- c(fields, paste(cur, collapse = "")); cur <- character(0); start <- TRUE
    } else {
      cur <- c(cur, c1); start <- FALSE
    }
    i <- i + 1L
  }
  c(fields, paste(cur, collapse = ""))
}
read_metadata <- function(path) {
  lines <- readLines(path, encoding = "UTF-8", warn = FALSE)
  lines <- sub("\r$", "", lines)
  if (length(lines)) lines[1] <- sub("^\ufeff", "", lines[1])
  lines <- lines[nzchar(trimws(lines))]
  if (!length(lines)) stop("the file is empty", call. = FALSE)
  head <- tolower(trimws(split_csv_line(lines[1])))
  rows <- lapply(lines[-1], split_csv_line)
  col <- function(name) {
    j <- match(name, head)
    if (is.na(j)) return(NULL)
    vapply(rows, function(r) if (length(r) >= j) r[j] else "", character(1))
  }
  list(names = head, sample = col("sample"), date = col("date"))
}
meta_user <- NULL
if (nzchar(META_IN)) {
  if (!file.exists(META_IN))
    stop("MANTA_METADATA is set, but the file does not exist: ", META_IN, call. = FALSE)
  meta_user <- tryCatch(read_metadata(META_IN),
    error = function(e) stop("cannot read MANTA_METADATA (", META_IN, "): ", conditionMessage(e),
                             call. = FALSE))
  if (is.null(meta_user$sample) || is.null(meta_user$date))
    stop("MANTA_METADATA must be a ';'-separated CSV with the columns 'sample' and 'date'; found: ",
         paste(meta_user$names, collapse = ", "), call. = FALSE)
}
check_metadata <- function(samples) {
  if (is.null(meta_user)) return(invisible(NULL))
  missing <- setdiff(samples, meta_user$sample)
  if (length(missing))
    stop("MANTA_METADATA has no row for ", length(missing), " sample(s): ",
         paste(head(missing, 5), collapse = ", "), ". The 'sample' column must hold the FASTQ ",
         "name before _S<n>_L001, e.g. ", samples[1], call. = FALSE)
  d <- meta_user$date[match(samples, meta_user$sample)]
  ok <- grepl("^[0-9]{4}-[0-9]{2}-[0-9]{2}", d) &
    !is.na(as.Date(substr(d, 1, 10), format = "%Y-%m-%d"))
  if (!all(ok))
    stop("MANTA_METADATA: the date of ", sum(!ok), " sample(s) is not a valid YYYY-MM-DD date: ",
         paste(head(samples[!ok], 5), collapse = ", "), call. = FALSE)
  invisible(NULL)
}

dir.create(out, showWarnings = FALSE, recursive = TRUE)
tmp <- file.path(out, "tmp"); dir.create(tmp, showWarnings = FALSE)
preFilt_dir <- file.path(tmp, "preFilt"); dir.create(preFilt_dir, showWarnings = FALSE)
cut_dir  <- file.path(tmp, "cutadapt"); dir.create(cut_dir, showWarnings = FALSE)
filt_dir <- file.path(tmp, "filtered"); dir.create(filt_dir, showWarnings = FALSE)

cache_path <- function(name) {
  p <- file.path(tmp, name); alt <- file.path(out, name)
  if (!file.exists(p) && file.exists(alt)) file.rename(alt, p)
  p
}
cache <- cache_path("_seqtab_cache.Rdata")
if (file.exists(cache)) {
  load(cache)
  cat("Cache loaded ->", ncol(seqtab.nochim), "ASVs x", nrow(seqtab.nochim), "samples\n")
  check_metadata(sample.names)
} else {

fnFs <- sort(list.files(src, pattern = "_R1_001.fastq.gz$", full.names = TRUE))
fnRs <- sort(list.files(src, pattern = "_R2_001.fastq.gz$", full.names = TRUE))
if (length(fnFs) == 0)
  stop("no files matching *_R1_001.fastq.gz in ", src, call. = FALSE)
if (length(fnFs) != length(fnRs))
  stop(length(fnFs), " *_R1_001.fastq.gz but ", length(fnRs), " *_R2_001.fastq.gz files in ", src,
       " - the reads must be paired", call. = FALSE)
sample.names <- sapply(strsplit(basename(fnFs), "_S[0-9]+_L001"), `[`, 1)
cat("Samples:", length(sample.names), "\n")
check_metadata(sample.names)

FWD.RC <- dada2:::rc(FWD_PRIMER); REV.RC <- dada2:::rc(REV_PRIMER)

fnFs.pre <- file.path(preFilt_dir, basename(fnFs)); fnRs.pre <- file.path(preFilt_dir, basename(fnRs))
filterAndTrim(fnFs, fnFs.pre, fnRs, fnRs.pre, minLen = 100, multithread = NCORES)
cat("prefilter ok\n")

fnFs.cut <- file.path(cut_dir, basename(fnFs)); fnRs.cut <- file.path(cut_dir, basename(fnRs))
for (i in seq_along(fnFs)) {
  system2("cutadapt", args = c(paste("-g", FWD_PRIMER, "-a", REV.RC),
                               paste("-G", REV_PRIMER, "-A", FWD.RC), "-n", 2,
                               "-o", fnFs.cut[i], "-p", fnRs.cut[i],
                               fnFs.pre[i], fnRs.pre[i]), stdout = NULL)
}
cat("cutadapt ok\n")

filtFs <- file.path(filt_dir, basename(fnFs)); filtRs <- file.path(filt_dir, basename(fnRs))
names(filtFs) <- sample.names; names(filtRs) <- sample.names
track_ft <- filterAndTrim(fnFs.cut, filtFs, fnRs.cut, filtRs, maxN = 0,
                          maxEE = c(MAXEE_F, MAXEE_R), truncLen = c(TRUNC_F, TRUNC_R),
                          rm.phix = TRUE, compress = TRUE, multithread = NCORES)
cat("filterAndTrim ok\n")

errF <- learnErrors(filtFs, multithread = NCORES); errR <- learnErrors(filtRs, multithread = NCORES)
dadaFs <- dada(filtFs, err = errF, multithread = NCORES)
dadaRs <- dada(filtRs, err = errR, multithread = NCORES)
mergers <- mergePairs(dadaFs, filtFs, dadaRs, filtRs, minOverlap = MIN_OVERLAP, verbose = TRUE)
seqtab <- makeSequenceTable(mergers)

sldist <- as.numeric(names(which.max(table(nchar(getSequences(seqtab))))))
lft <- round(sldist - 0.025 * sldist); rgt <- round(sldist + 0.025 * sldist)
cat("Modal length:", sldist, "-> keeping", lft, ":", rgt, "\n")
seqtab2 <- seqtab[, nchar(colnames(seqtab)) %in% lft:rgt, drop = FALSE]
seqtab.nochim <- removeBimeraDenovo(seqtab2, method = "consensus", multithread = NCORES,
                                    verbose = TRUE)

getN <- function(x) sum(getUniques(x))
track <- cbind(track_ft, sapply(dadaFs, getN), sapply(dadaRs, getN),
               sapply(mergers, getN), rowSums(seqtab.nochim))
colnames(track) <- c("input", "filtered", "denoisedF", "denoisedR", "merged", "nonchim")
rownames(track) <- sample.names
save(seqtab.nochim, track, sample.names, file = cache)

}

cat("\n=== READ-TRACKING ===\n"); print(track)
cat("retained (nonchim/input):", round(track[, "nonchim"] / track[, "input"], 4), "\n")
cat("ASVs before filter:", ncol(seqtab.nochim), "\n")

tot <- colSums(seqtab.nochim)
keep <- names(sort(tot, decreasing = TRUE))[seq_len(min(TOP_N, length(tot)))]
seqtab.f <- seqtab.nochim[, keep, drop = FALSE]
cat("Filter: top", length(keep), "ASVs by total reads ->",
    round(100 * sum(seqtab.f) / sum(seqtab.nochim), 1), "% of the reads kept\n")

seq <- colnames(seqtab.f)
PREFIX <- Sys.getenv("MANTA_ASV_PREFIX", "asv")
width <- max(3L, nchar(as.character(length(seq) - 1L)))
names(seq) <- sprintf(paste0(PREFIX, "_asv_%0", width, "d"), seq_along(seq) - 1L)
writeLines(as.vector(rbind(paste0(">", names(seq)), unname(seq))), file.path(out, "otu_seq_prok.fa"))

abundMatRaw <- seqtab.f
colnames(abundMatRaw) <- names(seq)[match(colnames(seqtab.f), seq)]
abundMatRaw <- t(abundMatRaw)
save(abundMatRaw, file = file.path(out, "RawAbundanceMat_prok.Rdata"))
save(track, file = file.path(out, "track_prok.Rdata"))

tax_cache <- cache_path("_taxa_cache.Rdata")
if (!HAS_TAX) {
  RANKS <- c("Kingdom", "Phylum", "Class", "Order", "Family", "Genus", "Species")
  prok_taxa <- matrix("unassigned", nrow = length(seq), ncol = length(RANKS),
                      dimnames = list(names(seq), RANKS))
  prok_taxa[, "Kingdom"] <- KINGDOM
  save(prok_taxa, file = file.path(out, "taxa_prok.Rdata"))
  cat("Taxonomy skipped - ASVs stay unassigned\n")
} else if (file.exists(tax_cache)) {
  load(tax_cache); cat("Taxonomy cache loaded\n")
} else {
  cat("assignTaxonomy against PR2 (the most memory-hungry step of the run) ...\n")
  t0 <- Sys.time()
  PR2_RANKS <- c("Domain", "Supergroup", "Division", "Subdivision", "Class", "Order",
                 "Family", "Genus", "Species")
  taxa_pr2 <- assignTaxonomy(seqtab.f, PR2, taxLevels = PR2_RANKS,
                             multithread = NCORES, verbose = TRUE)
  cat("assignTaxonomy done in", round(difftime(Sys.time(), t0, units = "mins"), 1), "min\n")
  save(taxa_pr2, file = tax_cache)
}


if (HAS_TAX) {
stopifnot(nrow(taxa_pr2) == length(seq))
RANKS <- c("Kingdom", "Phylum", "Class", "Order", "Family", "Genus", "Species")
SRC   <- c(Kingdom = "Domain", Phylum = "Division", Class = "Class", Order = "Order",
           Family = "Family", Genus = "Genus", Species = "Species")
prok_taxa <- matrix("unassigned", nrow = length(seq), ncol = length(RANKS),
                    dimnames = list(names(seq), RANKS))
tax_by_asv <- taxa_pr2[match(unname(seq), rownames(taxa_pr2)), , drop = FALSE]
for (r in RANKS) {
  col <- SRC[[r]]
  if (col %in% colnames(tax_by_asv)) {
    v <- as.character(tax_by_asv[, col])
    v[is.na(v) | v == ""] <- "unassigned"
    prok_taxa[, r] <- v
  }
}
save(prok_taxa, file = file.path(out, "taxa_prok.Rdata"))
cat("Taxonomy assigned - genus known for",
    sum(prok_taxa[, "Genus"] != "unassigned"), "of", nrow(prok_taxa), "ASVs\n")
}

if (!is.null(meta_user)) {
  file.copy(META_IN, file.path(out, "metadata.csv"), overwrite = TRUE)
  unlink(file.path(out, PLACEHOLDER_DATES))
  cat("metadata.csv copied from", META_IN, "\n")
} else {
  ord <- order(suppressWarnings(as.integer(sub(".*-", "", sample.names))))
  dates <- sprintf("2017-%02d-%02d", 1 + (seq_along(sample.names) - 1) %/% 28,
                   1 + (seq_along(sample.names) - 1) %% 28)
  meta <- data.frame(sample = sample.names[ord], date = dates, bottle = seq_along(sample.names))
  writeLines(c("sample;date;bottle", paste(meta$sample, meta$date, meta$bottle, sep = ";")),
             file.path(out, "metadata.csv"))
  writeLines(c(
    "The dates in metadata.csv are placeholders written by run_dada2.R because MANTA_METADATA",
    "was not set. They only encode the order of the samples; they are not sampling dates.",
    "Ingest this dataset with --time-axis ordinal. For real dates, rerun run_dada2.R into the",
    "same output folder with MANTA_METADATA=<metadata.csv> (the DADA2 result is reused).",
    "If you replace metadata.csv with real sampling dates by hand, delete this file."),
    file.path(out, PLACEHOLDER_DATES))
  message("WARNING: MANTA_METADATA is not set, so there are no real sampling dates. ",
          "metadata.csv holds placeholder dates that only encode the sample order, marked by ",
          PLACEHOLDER_DATES, ". Ingest with --time-axis ordinal (no month, year or season ",
          "statements). For real dates, rerun into the same folder with ",
          "MANTA_METADATA=<metadata.csv> (';'-separated, columns sample;date, dates YYYY-MM-DD).")
}

cat("\nDADA2_OK:", nrow(abundMatRaw), "ASVs x", ncol(abundMatRaw), "Samples ->",
    normalizePath(out), "\n")


j_str <- function(x) {
  if (is.null(x) || length(x) == 0 || (length(x) == 1 && is.na(x))) return("null")
  paste0("\"", gsub("\"", "\\\\\"", gsub("\\\\", "\\\\\\\\", as.character(x))), "\"")
}
j_num <- function(x) if (is.null(x) || length(x) == 0 || is.na(x)) "null" else as.character(x)
j_obj <- function(pairs, indent = 2) {
  pad <- strrep(" ", indent)
  paste0("{\n", paste0(pad, "\"", names(pairs), "\": ", unlist(pairs), collapse = ",\n"),
         "\n", strrep(" ", indent - 2), "}")
}

ref_name <- if (HAS_TAX) basename(PR2) else NA
ref_md5  <- if (HAS_TAX) unname(tools::md5sum(PR2)) else NA
ref_ver  <- if (HAS_TAX) {
  m <- regmatches(ref_name, regexpr("[0-9]+\\.[0-9]+(\\.[0-9]+)?", ref_name))
  if (length(m) == 1) m else NA
} else NA

si <- sessionInfo()
pkgs <- c(si$otherPkgs, si$loadedOnly)
pkg_lines <- paste0(names(pkgs), " ", vapply(pkgs, function(p) as.character(p$Version), ""))

manifest <- j_obj(list(
  tool = j_str("dada2"),
  dada2_version = j_str(as.character(packageVersion("dada2"))),
  r_version = j_str(R.version.string),
  written_at = j_str(format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC")),
  params = j_obj(list(
    trunc_len_f = j_num(TRUNC_F),
    trunc_len_r = j_num(TRUNC_R),
    max_ee_f = j_num(MAXEE_F),
    max_ee_r = j_num(MAXEE_R),
    min_overlap = j_num(MIN_OVERLAP),
    min_len = j_num(100),
    fwd_primer = j_str(FWD_PRIMER),
    rev_primer = j_str(REV_PRIMER),
    chimera_method = j_str("consensus"),
    reference = j_str(ref_name),
    reference_version = j_str(ref_ver),
    reference_md5 = j_str(ref_md5),
    kingdom_filter = j_str(if (HAS_TAX) "PR2 Domain -> Kingdom" else KINGDOM),
    top_n = j_num(TOP_N),
    asv_prefix = j_str(PREFIX),
    length_window_lo = if (exists("lft")) j_num(lft) else "null",
    length_window_hi = if (exists("rgt")) j_num(rgt) else "null",
    num_cores = j_num(NCORES)
  ), indent = 6),
  session_info = paste0("[", paste0(vapply(pkg_lines, j_str, ""), collapse = ", "), "]")
), indent = 4)

writeLines(manifest, file.path(out, "dada2_manifest.json"))
cat("dada2_manifest.json written -", length(pkg_lines), "packages,",
    if (HAS_TAX) paste("reference", ref_name) else "no reference", "\n")
