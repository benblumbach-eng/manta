
here <- dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE)))
rlib <- file.path(normalizePath(here), "rlib")
dir.create(rlib, showWarnings = FALSE)
.libPaths(c(rlib, .libPaths()))

deps <- c("Rcpp", "RcppArmadillo", "foreach", "doParallel", "stringdist", "magrittr",
          "jsonlite", "gtools")
missing <- setdiff(deps, rownames(installed.packages(lib.loc = rlib)))
missing <- setdiff(missing, rownames(installed.packages()))
if (length(missing)) {
  install.packages(missing, lib = rlib, repos = "https://cloud.r-project.org")
}

clt <- "/Library/Developer/CommandLineTools"
fixes <- character(0)
if (!file.exists(file.path(clt, "usr/include/c++/v1/vector")) &&
    file.exists(file.path(clt, "SDKs/MacOSX.sdk/usr/include/c++/v1/vector"))) {
  fixes <- c(fixes, sprintf("CPPFLAGS += -stdlib++-isystem %s/SDKs/MacOSX.sdk/usr/include/c++/v1", clt))
}
if (!dir.exists("/opt/gfortran")) {
  fixes <- c(fixes, "FLIBS =")
}
if (length(fixes)) {
  mv <- file.path(tempdir(), "Makevars.toolchain-fix")
  writeLines(fixes, mv)
  Sys.setenv(R_MAKEVARS_USER = mv)
}

if (!("rELA" %in% rownames(installed.packages(lib.loc = rlib)))) {
  tarball <- file.path(here, "vendor", "rELA.v0.80.3.tar.gz")
  if (!file.exists(tarball)) {
    stop("rELA-Tarball fehlt: zuerst  bash tools/ela/fetch_rela.sh  ausfuehren")
  }
  expected <- "aa4718529e7e2da727d3df73fcbc470551f1f8e0d3b1a3452bf931c27bfccd8a"
  actual <- strsplit(system2("shasum", c("-a", "256", tarball), stdout = TRUE), " ")[[1]][1]
  if (!identical(actual, expected)) {
    stop(sprintf("%s: SHA-256 %s != erwartet %s", basename(tarball), actual, expected))
  }
  install.packages(tarball, lib = rlib, repos = NULL, type = "source")
}

library(rELA, lib.loc = rlib)
cat(sprintf("rELA %s bereit in %s\n", as.character(packageVersion("rELA")), rlib))
