# P&F Relative Strength — DW-style percentage scale

Vite + React project for building a Nasdaq Dorsey Wright style point & figure relative strength chart from two asset series.

## Run

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## What changed

- Relative Strength is calculated as `Asset 1 / Asset 2 * RS base`
- Percentage box scale uses a fixed geometric grid
- Reversal logic uses full `N`-box moves from the latest extreme
- Top and bottom year bands match the Nasdaq-style layout more closely
- Optional Nasdaq reference CSV auto-calibrates the RS base from the latest DW value

Sample files are included in `public/sample` and `public/reference`.
