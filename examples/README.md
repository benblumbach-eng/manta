# Example datasets

Two synthetic datasets, generated for MANTA, so that a first import needs no data of your own.
MIT License like the code.

| Folder | Samples | Time axis | Use |
|---|---|---|---|
| `synthetic_12_samples` | 12 | fortnightly, half a year | a first import, a few minutes |
| `synthetic_96_samples` | 96 | fortnightly, four years | a network worth looking at, considerably longer |

Both start on the same day and carry the same columns; the shorter one is the first half year of
the longer one's span.

Both are **DADA2 output** — entry point 2 of the three in the [README](../README.md#importing-data).
Each folder holds the five files that entry point expects:

| File | What it holds |
|---|---|
| `RawAbundanceMat_prok.Rdata` | the ASV table: counts per ASV and sample |
| `taxa_prok.Rdata` | the taxonomy of each ASV |
| `track_prok.Rdata` | the read tracking of the DADA2 run |
| `otu_seq_prok.fa` | the sequence of each ASV |
| `metadata.csv` | sample, date and the measured environment (`;`-separated) |

## Importing

In the interface on <http://localhost:5173>, under **Import a dataset**, choose **DADA2 output**
and select all five files of one folder. MANTA then runs OTTER over them and writes the result
into the graph; the import window shows the stages.

The environment columns in `metadata.csv` — mixed layer depth, temperature, polar water fraction,
chlorophyll, light, salinity, oxygen, depth — appear afterwards on the ASV pages and in the year
wheel, the same way measured data would.

On Windows the browser runs outside WSL. The file dialog reaches these files at
`\\wsl.localhost\Ubuntu\home\<you>\manta\examples\`.

> [!NOTE]
> The numbers are made up. They are there to exercise the chain and the interface, not to be
> interpreted — no conclusion about real communities follows from them.
