
suppressMessages({ library(dada2); library(Biostrings); library(ShortRead) })

args  <- commandArgs(trailingOnly = TRUE)
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
KINGDOM <- Sys.getenv("MANTA_KINGDOM", "unassigned")
cat("Kerne:", NCORES, "· Taxonomie:", if (HAS_TAX) PR2 else "AUS (ASVs bleiben unbeschriftet)", "\n")

dir.create(out, showWarnings = FALSE, recursive = TRUE)
tmp <- file.path(out, "tmp"); dir.create(tmp, showWarnings = FALSE)
preFilt_dir <- file.path(tmp, "preFilt"); dir.create(preFilt_dir, showWarnings = FALSE)
cut_dir  <- file.path(tmp, "cutadapt"); dir.create(cut_dir, showWarnings = FALSE)
filt_dir <- file.path(tmp, "filtered"); dir.create(filt_dir, showWarnings = FALSE)

cache <- file.path(out, "_seqtab_cache.Rdata")
if (file.exists(cache)) {
  load(cache)
  cat("Cache geladen ->", ncol(seqtab.nochim), "ASVs x", nrow(seqtab.nochim), "Samples\n")
} else {

fnFs <- sort(list.files(src, pattern = "_R1_001.fastq.gz$", full.names = TRUE))
fnRs <- sort(list.files(src, pattern = "_R2_001.fastq.gz$", full.names = TRUE))
stopifnot(length(fnFs) == length(fnRs), length(fnFs) > 0)
sample.names <- sapply(strsplit(basename(fnFs), "_S[0-9]+_L001"), `[`, 1)
cat("Samples:", length(sample.names), "\n")

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
cat("Modallaenge:", sldist, "-> behalte", lft, ":", rgt, "\n")
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
cat("ASVs vor Filter:", ncol(seqtab.nochim), "\n")

tot <- colSums(seqtab.nochim)
keep <- names(sort(tot, decreasing = TRUE))[seq_len(min(TOP_N, length(tot)))]
seqtab.f <- seqtab.nochim[, keep, drop = FALSE]
cat("Filter: Top", length(keep), "ASVs nach Gesamt-Reads ->",
    round(100 * sum(seqtab.f) / sum(seqtab.nochim), 1), "% der Reads behalten\n")

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

tax_cache <- file.path(out, "_taxa_cache.Rdata")
if (!HAS_TAX) {
  RANKS <- c("Kingdom", "Phylum", "Class", "Order", "Family", "Genus", "Species")
  prok_taxa <- matrix("unassigned", nrow = length(seq), ncol = length(RANKS),
                      dimnames = list(names(seq), RANKS))
  prok_taxa[, "Kingdom"] <- KINGDOM
  save(prok_taxa, file = file.path(out, "taxa_prok.Rdata"))
  cat("Taxonomie uebersprungen — ASVs bleiben unbeschriftet\n")
} else if (file.exists(tax_cache)) {
  load(tax_cache); cat("Taxonomie-Cache geladen\n")
} else {
  cat("assignTaxonomy gegen PR2 (speicherhungrigster Schritt des Laufs) ...\n")
  t0 <- Sys.time()
  PR2_RANKS <- c("Domain", "Supergroup", "Division", "Subdivision", "Class", "Order",
                 "Family", "Genus", "Species")
  taxa_pr2 <- assignTaxonomy(seqtab.f, PR2, taxLevels = PR2_RANKS,
                             multithread = NCORES, verbose = TRUE)
  cat("assignTaxonomy fertig in", round(difftime(Sys.time(), t0, units = "mins"), 1), "min\n")
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
cat("Taxonomie zugeordnet — Gattung bestimmt fuer",
    sum(prok_taxa[, "Genus"] != "unassigned"), "von", nrow(prok_taxa), "ASVs\n")
}

if (nzchar(META_IN) && file.exists(META_IN)) {
  file.copy(META_IN, file.path(out, "metadata.csv"), overwrite = TRUE)
  cat("metadata.csv uebernommen von", META_IN, "\n")
} else {
  ord <- order(as.integer(sub(".*-", "", sample.names)))
  dates <- sprintf("2017-%02d-%02d", 1 + (seq_along(sample.names) - 1) %/% 28,
                   1 + (seq_along(sample.names) - 1) %% 28)
  meta <- data.frame(sample = sample.names[ord], date = dates, bottle = seq_along(sample.names))
  writeLines(c("sample;date;bottle", paste(meta$sample, meta$date, meta$bottle, sep = ";")),
             file.path(out, "metadata.csv"))
  cat("KEINE echten Probendaten — synthetische Reihenfolge erzeugt\n")
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
cat("dada2_manifest.json geschrieben —", length(pkg_lines), "Pakete,",
    if (HAS_TAX) paste("Referenz", ref_name) else "ohne Referenz", "\n")
