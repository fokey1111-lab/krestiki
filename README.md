# Point & Figure Relative Strength

NASDAQ-style website for loading Excel/CSV files and building a Point & Figure Relative Strength chart for two assets.

## Run

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Relative Strength formula

```text
((Asset 1 / first Asset 1) / (Asset 2 / first Asset 2)) × Scale Base
```

## Features

- upload .xlsx / .xls / .csv
- choose two assets
- years at the top and bottom of chart
- green buy signals
- red sell signals
- month markers inside columns
- percent box scaling and reversal controls
