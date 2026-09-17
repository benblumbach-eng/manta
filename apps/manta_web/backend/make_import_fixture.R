
here <- dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE)[1]))
if (!nzchar(here)) here <- "."
tests <- normalizePath(file.path(here, "..", "..", "..", "submodules", "otter", "tests"))
args <- commandArgs(trailingOnly = TRUE)
out <- if (length(args) >= 1) args[1] else file.path(here, "import_fixture")
dir.create(out, showWarnings = FALSE, recursive = TRUE)

ab <- read.table(file.path(tests, "abundance.csv"), sep = ";", header = TRUE,
                 row.names = 1, check.names = FALSE)
ab50 <- ab[, 1:50]
abundMatRaw <- t(as.matrix(ab50))
save(abundMatRaw, file = file.path(out, "RawAbundanceMat_prok.Rdata"))
asvs <- rownames(abundMatRaw)
dates <- colnames(abundMatRaw)

tx <- read.table(file.path(tests, "taxa_info.csv"), sep = ";", header = TRUE,
                 row.names = 1, check.names = FALSE, quote = "", comment.char = "")
prok_taxa <- as.matrix(tx[asvs, c("Kingdom","Phylum","Class","Order","Family","Genus","Species")])
rownames(prok_taxa) <- asvs
save(prok_taxa, file = file.path(out, "taxa_prok.Rdata"))

bases <- c("A","C","G","T")
seqs <- vapply(seq_along(asvs), function(i) {
  set <- (i * 2654435761) %% (4^10)
  chars <- character(10)
  for (k in 1:10) { chars[k] <- bases[(set %% 4) + 1]; set <- set %/% 4 }
  paste0(chars, collapse = "")
}, character(1))
writeLines(as.vector(rbind(paste0(">", asvs), seqs)), file.path(out, "otu_seq_prok.fa"))

track <- cbind(input = rep(1000, length(dates)), filtered = rep(900, length(dates)),
               denoisedF = rep(880, length(dates)), denoisedR = rep(870, length(dates)),
               merged = rep(800, length(dates)), nonchim = rep(780, length(dates)))
rownames(track) <- dates
save(track, file = file.path(out, "track_prok.Rdata"))

env <- read.table(file.path(tests, "environment_info.csv"), sep = ";", header = TRUE,
                  row.names = 1, check.names = FALSE)
env <- env[dates, , drop = FALSE]
meta <- data.frame(sample = dates, date = dates, env, check.names = FALSE)
write.table(meta, file.path(out, "metadata.csv"), sep = ";", row.names = FALSE,
            quote = FALSE, na = "")

cat("import-fixture geschrieben:", normalizePath(out), "-", length(asvs), "ASV,",
    length(dates), "Samples\n")
