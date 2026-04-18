import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';

type Row = Record<string, unknown>;
type ParsedFile = { rows: Row[]; columns: string[]; fileName: string };
type PnfCell = { row: number; col: number; value: string; isMarker?: boolean };
type PnfColumn = {
  type: 'X' | 'O';
  boxes: number[];
  startDate: Date;
  endDate: Date;
  markers: { box: number; label: string }[];
};
type PnfResult = {
  columns: PnfColumn[];
  priceLevels: number[];
  cells: PnfCell[];
  current: number;
  previous: number | null;
  nextReversal: number | null;
  direction: 'X' | 'O' | null;
};

const monthMap = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C'];

function toDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number') {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const date = new Date(excelEpoch.getTime() + value * 86400000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/\s/g, '').replace(',', '.');
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function detectDateColumn(rows: Row[], columns: string[]): string {
  const scores = columns.map((col) => {
    let valid = 0;
    for (const row of rows.slice(0, 50)) {
      if (toDate(row[col])) valid += 1;
    }
    return { col, valid };
  });
  return scores.sort((a, b) => b.valid - a.valid)[0]?.col || columns[0] || '';
}

function detectNumericColumns(rows: Row[], columns: string[], dateColumn: string): string[] {
  return columns.filter((col) => {
    if (col === dateColumn) return false;
    let valid = 0;
    for (const row of rows.slice(0, 50)) {
      if (toNumber(row[col]) !== null) valid += 1;
    }
    return valid > 0;
  });
}

function buildRelativeStrengthSeries(rows: Row[], dateCol: string, leftCol: string, rightCol: string, scaleBase: number) {
  const items = rows
    .map((row) => {
      const date = toDate(row[dateCol]);
      const left = toNumber(row[leftCol]);
      const right = toNumber(row[rightCol]);
      if (!date || left === null || right === null || right === 0) return null;
      return { date, value: (left / right) * scaleBase };
    })
    .filter(Boolean) as { date: Date; value: number }[];

  items.sort((a, b) => a.date.getTime() - b.date.getTime());
  return items;
}

function uniqueSortedDescending(values: number[]) {
  return [...new Set(values)].sort((a, b) => b - a);
}

function labelForDate(date: Date) {
  return monthMap[date.getMonth()];
}

function createPnf(series: { date: Date; value: number }[], boxSize: number, reversalBoxes: number): PnfResult | null {
  if (!series.length || boxSize <= 0 || reversalBoxes < 1) return null;

  const columns: PnfColumn[] = [];
  let currentCol: PnfColumn | null = null;

  const anchor = Math.floor(series[0].value / boxSize) * boxSize;
  let lastBox = anchor;

  for (let i = 1; i < series.length; i += 1) {
    const { date, value } = series[i];
    if (!currentCol) {
      if (value >= lastBox + boxSize) {
        const boxes: number[] = [];
        for (let p = lastBox + boxSize; p <= Math.floor(value / boxSize) * boxSize + 1e-9; p += boxSize) {
          boxes.push(Number(p.toFixed(6)));
        }
        if (boxes.length) {
          currentCol = { type: 'X', boxes, startDate: date, endDate: date, markers: [{ box: boxes[0], label: labelForDate(date) }] };
          columns.push(currentCol);
          lastBox = boxes[boxes.length - 1];
        }
      } else if (value <= lastBox - boxSize) {
        const boxes: number[] = [];
        for (let p = lastBox - boxSize; p >= Math.ceil(value / boxSize) * boxSize - 1e-9; p -= boxSize) {
          boxes.push(Number(p.toFixed(6)));
        }
        if (boxes.length) {
          currentCol = { type: 'O', boxes, startDate: date, endDate: date, markers: [{ box: boxes[0], label: labelForDate(date) }] };
          columns.push(currentCol);
          lastBox = boxes[boxes.length - 1];
        }
      }
      continue;
    }

    if (currentCol.type === 'X') {
      const top = currentCol.boxes[currentCol.boxes.length - 1];
      if (value >= top + boxSize) {
        const start = top + boxSize;
        const end = Math.floor(value / boxSize) * boxSize;
        for (let p = start; p <= end + 1e-9; p += boxSize) currentCol.boxes.push(Number(p.toFixed(6)));
        currentCol.endDate = date;
        if (currentCol.markers[currentCol.markers.length - 1]?.label !== labelForDate(date)) {
          currentCol.markers.push({ box: Number(start.toFixed(6)), label: labelForDate(date) });
        }
        lastBox = currentCol.boxes[currentCol.boxes.length - 1];
      } else if (value <= top - reversalBoxes * boxSize) {
        const first = top - boxSize;
        const end = Math.ceil(value / boxSize) * boxSize;
        const boxes: number[] = [];
        for (let p = first; p >= end - 1e-9; p -= boxSize) boxes.push(Number(p.toFixed(6)));
        currentCol = { type: 'O', boxes, startDate: date, endDate: date, markers: [{ box: boxes[0], label: labelForDate(date) }] };
        columns.push(currentCol);
        lastBox = currentCol.boxes[currentCol.boxes.length - 1];
      }
    } else {
      const bottom = currentCol.boxes[currentCol.boxes.length - 1];
      if (value <= bottom - boxSize) {
        const start = bottom - boxSize;
        const end = Math.ceil(value / boxSize) * boxSize;
        for (let p = start; p >= end - 1e-9; p -= boxSize) currentCol.boxes.push(Number(p.toFixed(6)));
        currentCol.endDate = date;
        if (currentCol.markers[currentCol.markers.length - 1]?.label !== labelForDate(date)) {
          currentCol.markers.push({ box: Number(start.toFixed(6)), label: labelForDate(date) });
        }
        lastBox = currentCol.boxes[currentCol.boxes.length - 1];
      } else if (value >= bottom + reversalBoxes * boxSize) {
        const first = bottom + boxSize;
        const end = Math.floor(value / boxSize) * boxSize;
        const boxes: number[] = [];
        for (let p = first; p <= end + 1e-9; p += boxSize) boxes.push(Number(p.toFixed(6)));
        currentCol = { type: 'X', boxes, startDate: date, endDate: date, markers: [{ box: boxes[0], label: labelForDate(date) }] };
        columns.push(currentCol);
        lastBox = currentCol.boxes[currentCol.boxes.length - 1];
      }
    }
  }

  if (!columns.length) return null;

  const allBoxes = columns.flatMap((col) => col.boxes);
  const levels = uniqueSortedDescending(allBoxes);
  const rowMap = new Map<number, number>(levels.map((level, index) => [Number(level.toFixed(6)), index]));
  const cells: PnfCell[] = [];

  columns.forEach((col, colIndex) => {
    col.boxes.forEach((box) => {
      const row = rowMap.get(Number(box.toFixed(6)));
      if (row !== undefined) cells.push({ row, col: colIndex, value: col.type });
    });
    col.markers.forEach((m) => {
      const row = rowMap.get(Number(m.box.toFixed(6)));
      if (row !== undefined) cells.push({ row, col: colIndex, value: m.label, isMarker: true });
    });
  });

  const last = columns[columns.length - 1];
  const current = last.boxes[last.boxes.length - 1];
  const previous = columns.length > 1 ? columns[columns.length - 2].boxes[columns[columns.length - 2].boxes.length - 1] : null;
  const nextReversal = last.type === 'X'
    ? current - reversalBoxes * boxSize
    : current + reversalBoxes * boxSize;

  return {
    columns,
    priceLevels: levels,
    cells,
    current,
    previous,
    nextReversal,
    direction: last.type,
  };
}

function formatNumber(value: number | null, digits = 4) {
  if (value === null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function App() {
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [dateColumn, setDateColumn] = useState('');
  const [leftColumn, setLeftColumn] = useState('');
  const [rightColumn, setRightColumn] = useState('');
  const [boxSize, setBoxSize] = useState(3.25);
  const [reversalBoxes, setReversalBoxes] = useState(3);
  const [scaleBase, setScaleBase] = useState(100);
  const [error, setError] = useState('');

  async function handleFileUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError('');

    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Row>(sheet, { defval: null, raw: true });
      const columns = rows.length ? Object.keys(rows[0]) : [];
      const nextParsed = { rows, columns, fileName: file.name };
      setParsed(nextParsed);
      const detectedDate = detectDateColumn(rows, columns);
      const numericCols = detectNumericColumns(rows, columns, detectedDate);
      setDateColumn(detectedDate);
      setLeftColumn(numericCols[0] || '');
      setRightColumn(numericCols[1] || numericCols[0] || '');
    } catch (e) {
      setError('Could not read the file. Upload .xlsx, .xls or .csv.');
    }
  }

  useEffect(() => {
    async function loadSample() {
      try {
        const response = await fetch('/sample/chart(871).xlsx');
        const buffer = await response.arrayBuffer();
        const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<Row>(sheet, { defval: null, raw: true });
        const columns = rows.length ? Object.keys(rows[0]) : [];
        const nextParsed = { rows, columns, fileName: 'chart(871).xlsx' };
        setParsed(nextParsed);
        const detectedDate = detectDateColumn(rows, columns);
        const numericCols = detectNumericColumns(rows, columns, detectedDate);
        setDateColumn(detectedDate);
        setLeftColumn(numericCols[0] || '');
        setRightColumn(numericCols[1] || numericCols[0] || '');
      } catch {
        // ignore sample loading issues
      }
    }
    loadSample();
  }, []);

  const numericColumns = useMemo(() => {
    if (!parsed) return [];
    return detectNumericColumns(parsed.rows, parsed.columns, dateColumn);
  }, [parsed, dateColumn]);

  const rsSeries = useMemo(() => {
    if (!parsed || !dateColumn || !leftColumn || !rightColumn) return [];
    return buildRelativeStrengthSeries(parsed.rows, dateColumn, leftColumn, rightColumn, scaleBase);
  }, [parsed, dateColumn, leftColumn, rightColumn, scaleBase]);

  const pnf = useMemo(() => createPnf(rsSeries, boxSize, reversalBoxes), [rsSeries, boxSize, reversalBoxes]);

  const currentRaw = rsSeries.length ? rsSeries[rsSeries.length - 1].value : null;
  const previousRaw = rsSeries.length > 1 ? rsSeries[rsSeries.length - 2].value : null;
  const changeRaw = currentRaw !== null && previousRaw !== null ? currentRaw - previousRaw : null;
  const pctChange = currentRaw !== null && previousRaw !== null && previousRaw !== 0 ? (changeRaw! / previousRaw) * 100 : null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">Point & Figure Relative Strength</div>
        <div className="brand-sub">Nasdaq-style comparison for two assets</div>
      </header>

      <section className="panel controls">
        <div className="control-row">
          <label className="file-upload">
            <span>Upload Excel / CSV</span>
            <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFileUpload} />
          </label>
          <div className="file-name">{parsed ? `Loaded: ${parsed.fileName}` : 'No file loaded'}</div>
        </div>

        {parsed && (
          <>
            <div className="control-grid">
              <label>
                <span>Date column</span>
                <select value={dateColumn} onChange={(e) => setDateColumn(e.target.value)}>
                  {parsed.columns.map((col) => <option key={col} value={col}>{col}</option>)}
                </select>
              </label>
              <label>
                <span>Asset 1</span>
                <select value={leftColumn} onChange={(e) => setLeftColumn(e.target.value)}>
                  {numericColumns.map((col) => <option key={col} value={col}>{col}</option>)}
                </select>
              </label>
              <label>
                <span>Asset 2</span>
                <select value={rightColumn} onChange={(e) => setRightColumn(e.target.value)}>
                  {numericColumns.map((col) => <option key={col} value={col}>{col}</option>)}
                </select>
              </label>
              <label>
                <span>Scale base</span>
                <input type="number" step="1" value={scaleBase} onChange={(e) => setScaleBase(Number(e.target.value) || 100)} />
              </label>
              <label>
                <span>Box size</span>
                <input type="number" step="0.01" value={boxSize} onChange={(e) => setBoxSize(Number(e.target.value) || 1)} />
              </label>
              <label>
                <span>Reversal</span>
                <input type="number" step="1" min="1" value={reversalBoxes} onChange={(e) => setReversalBoxes(Math.max(1, Number(e.target.value) || 3))} />
              </label>
            </div>
          </>
        )}

        {error && <div className="error-box">{error}</div>}
      </section>

      <section className="panel summary">
        <div className="pair-title">
          <strong>{leftColumn || 'Asset 1'}</strong>
          <span>vs</span>
          <strong>{rightColumn || 'Asset 2'}</strong>
        </div>
        <div className="metrics">
          <div className="metric"><span>RS Calc</span><strong>{formatNumber(currentRaw, 4)}</strong></div>
          <div className="metric"><span>Box size</span><strong>{formatNumber(boxSize, 2)}</strong></div>
          <div className="metric"><span>Reversal</span><strong>{reversalBoxes}</strong></div>
          <div className="metric"><span>Previous close</span><strong>{formatNumber(previousRaw, 4)}</strong></div>
          <div className="metric"><span>Δ</span><strong className={changeRaw !== null && changeRaw < 0 ? 'down' : 'up'}>{formatNumber(changeRaw, 4)}</strong></div>
          <div className="metric"><span>Δ %</span><strong className={pctChange !== null && pctChange < 0 ? 'down' : 'up'}>{formatNumber(pctChange, 2)}%</strong></div>
          <div className="metric"><span>Next reversal</span><strong>{pnf ? formatNumber(pnf.nextReversal, 4) : '—'}</strong></div>
          <div className="metric"><span>Direction</span><strong>{pnf?.direction || '—'}</strong></div>
        </div>
      </section>

      <section className="panel chart-panel">
        {pnf ? (
          <PnfChart pnf={pnf} />
        ) : (
          <div className="empty-state">Not enough movement yet to build a point & figure chart. Try a smaller box size.</div>
        )}
      </section>

      <section className="panel notes">
        <h3>How it works</h3>
        <p>The app reads two numeric columns from Excel, calculates relative strength as Asset 1 ÷ Asset 2 × Scale Base, then builds a point & figure chart using your box size and reversal settings.</p>
        <p>Use this to compare two strategies, indexes, funds, or portfolios in the same dataset.</p>
      </section>
    </div>
  );
}

function PnfChart({ pnf }: { pnf: PnfResult }) {
  const { columns, priceLevels, cells } = pnf;
  const cellSize = 22;
  const width = Math.max(columns.length * cellSize + 160, 960);
  const height = priceLevels.length * cellSize + 80;
  const cellMap = new Map(cells.map((cell) => [`${cell.row}-${cell.col}`, cell]));

  return (
    <div className="chart-wrap">
      <div className="chart-grid" style={{ width, minHeight: height }}>
        <div className="axis top" style={{ gridTemplateColumns: `120px repeat(${columns.length}, ${cellSize}px) 120px` }}>
          <div className="axis-corner" />
          {columns.map((col, i) => (
            <div key={`top-${i}`} className="axis-top-cell">{String(i + 1).padStart(2, '0')}</div>
          ))}
          <div className="axis-corner" />
        </div>

        <div className="body" style={{ gridTemplateColumns: `120px repeat(${columns.length}, ${cellSize}px) 120px` }}>
          {priceLevels.map((level, rowIndex) => (
            <>
              <div key={`left-${rowIndex}`} className="axis-label">{level.toFixed(4)}</div>
              {columns.map((_, colIndex) => {
                const cell = cellMap.get(`${rowIndex}-${colIndex}`);
                return (
                  <div key={`${rowIndex}-${colIndex}`} className={`grid-cell ${cell?.value === 'X' ? 'cell-x' : ''} ${cell?.value === 'O' ? 'cell-o' : ''}`}>
                    {cell ? <span className={cell.isMarker ? 'marker' : ''}>{cell.value}</span> : null}
                  </div>
                );
              })}
              <div key={`right-${rowIndex}`} className="axis-label">{level.toFixed(4)}</div>
            </>
          ))}
        </div>
      </div>
    </div>
  );
}

export default App;
