import { ChangeEvent, Fragment, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';

type Row = Record<string, unknown>;
type ParsedFile = { rows: Row[]; columns: string[]; fileName: string };
type SignalType = 'buy' | 'sell';
type PnfCell = { row: number; col: number; value: string; isMarker?: boolean; signal?: SignalType };
type PnfColumn = {
  type: 'X' | 'O';
  boxes: number[]; // box indices on percentage scale
  startDate: Date;
  endDate: Date;
  markers: { box: number; label: string }[];
  signal?: SignalType;
  signalBox?: number;
};
type PnfResult = {
  columns: PnfColumn[];
  priceLevels: number[]; // rendered price values
  cells: PnfCell[];
  current: number;
  previous: number | null;
  nextReversal: number | null;
  nextReversalPct: number | null;
  direction: 'X' | 'O' | null;
  lastSignal: SignalType | null;
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
  const aligned = rows
    .map((row) => {
      const date = toDate(row[dateCol]);
      const left = toNumber(row[leftCol]);
      const right = toNumber(row[rightCol]);
      if (!date || left === null || right === null || left <= 0 || right <= 0) return null;
      return { date, left, right };
    })
    .filter(Boolean) as { date: Date; left: number; right: number }[];

  aligned.sort((a, b) => a.date.getTime() - b.date.getTime());
  if (!aligned.length) return [];

  return aligned.map((item) => ({
    date: item.date,
    value: (item.left / item.right) * scaleBase,
  }));
}

function labelForDate(date: Date) {
  return monthMap[date.getMonth()];
}

function detectSignals(columns: PnfColumn[]) {
  for (let i = 0; i < columns.length; i += 1) {
    const current = columns[i];
    if (current.type === 'X') {
      const prevX = [...columns.slice(0, i)].reverse().find((col) => col.type === 'X');
      if (prevX) {
        const currentTop = current.boxes[current.boxes.length - 1];
        const prevTop = prevX.boxes[prevX.boxes.length - 1];
        if (currentTop > prevTop) {
          current.signal = 'buy';
          current.signalBox = currentTop;
        }
      }
    } else {
      const prevO = [...columns.slice(0, i)].reverse().find((col) => col.type === 'O');
      if (prevO) {
        const currentBottom = current.boxes[current.boxes.length - 1];
        const prevBottom = prevO.boxes[prevO.boxes.length - 1];
        if (currentBottom < prevBottom) {
          current.signal = 'sell';
          current.signalBox = currentBottom;
        }
      }
    }
  }
}

function getBoxIndex(value: number, anchor: number, step: number) {
  const raw = Math.log(value / anchor) / Math.log(step);
  if (!Number.isFinite(raw)) return 0;
  return Math.floor(raw + 1e-12);
}

function levelFromIndex(index: number, anchor: number, step: number) {
  return anchor * step ** index;
}

function createPnf(series: { date: Date; value: number }[], boxPercent: number, reversalBoxes: number): PnfResult | null {
  if (!series.length || boxPercent <= 0 || reversalBoxes < 1) return null;

  const step = 1 + boxPercent / 100;
  const anchor = 1;
  if (!(step > 1)) return null;

  const columns: PnfColumn[] = [];
  let currentCol: PnfColumn | null = null;
  let lastIndex = getBoxIndex(series[0].value, anchor, step);

  for (let i = 1; i < series.length; i += 1) {
    const { date, value } = series[i];
    const valueIndex = getBoxIndex(value, anchor, step);

    if (!currentCol) {
      if (valueIndex >= lastIndex + 1) {
        const boxes: number[] = [];
        for (let idx = lastIndex + 1; idx <= valueIndex; idx += 1) boxes.push(idx);
        if (boxes.length) {
          currentCol = { type: 'X', boxes, startDate: date, endDate: date, markers: [{ box: boxes[0], label: labelForDate(date) }] };
          columns.push(currentCol);
          lastIndex = boxes[boxes.length - 1];
        }
      } else if (valueIndex <= lastIndex - 1) {
        const boxes: number[] = [];
        for (let idx = lastIndex - 1; idx >= valueIndex; idx -= 1) boxes.push(idx);
        if (boxes.length) {
          currentCol = { type: 'O', boxes, startDate: date, endDate: date, markers: [{ box: boxes[0], label: labelForDate(date) }] };
          columns.push(currentCol);
          lastIndex = boxes[boxes.length - 1];
        }
      }
      continue;
    }

    if (currentCol.type === 'X') {
      const top = currentCol.boxes[currentCol.boxes.length - 1];
      if (valueIndex >= top + 1) {
        const start = top + 1;
        for (let idx = start; idx <= valueIndex; idx += 1) currentCol.boxes.push(idx);
        currentCol.endDate = date;
        if (currentCol.markers[currentCol.markers.length - 1]?.label !== labelForDate(date)) {
          currentCol.markers.push({ box: start, label: labelForDate(date) });
        }
        lastIndex = currentCol.boxes[currentCol.boxes.length - 1];
      } else if (valueIndex <= top - reversalBoxes) {
        const first = top - 1;
        const boxes: number[] = [];
        for (let idx = first; idx >= valueIndex; idx -= 1) boxes.push(idx);
        currentCol = { type: 'O', boxes, startDate: date, endDate: date, markers: [{ box: boxes[0], label: labelForDate(date) }] };
        columns.push(currentCol);
        lastIndex = currentCol.boxes[currentCol.boxes.length - 1];
      }
    } else {
      const bottom = currentCol.boxes[currentCol.boxes.length - 1];
      if (valueIndex <= bottom - 1) {
        const start = bottom - 1;
        for (let idx = start; idx >= valueIndex; idx -= 1) currentCol.boxes.push(idx);
        currentCol.endDate = date;
        if (currentCol.markers[currentCol.markers.length - 1]?.label !== labelForDate(date)) {
          currentCol.markers.push({ box: start, label: labelForDate(date) });
        }
        lastIndex = currentCol.boxes[currentCol.boxes.length - 1];
      } else if (valueIndex >= bottom + reversalBoxes) {
        const first = bottom + 1;
        const boxes: number[] = [];
        for (let idx = first; idx <= valueIndex; idx += 1) boxes.push(idx);
        currentCol = { type: 'X', boxes, startDate: date, endDate: date, markers: [{ box: boxes[0], label: labelForDate(date) }] };
        columns.push(currentCol);
        lastIndex = currentCol.boxes[currentCol.boxes.length - 1];
      }
    }
  }

  if (!columns.length) return null;

  detectSignals(columns);

  const allBoxes = [...new Set(columns.flatMap((col) => col.boxes))].sort((a, b) => b - a);
  const rowMap = new Map<number, number>(allBoxes.map((level, index) => [level, index]));
  const cells: PnfCell[] = [];

  columns.forEach((col, colIndex) => {
    col.boxes.forEach((box) => {
      const row = rowMap.get(box);
      if (row !== undefined) {
        const isSignal = col.signalBox !== undefined && box === col.signalBox;
        cells.push({ row, col: colIndex, value: col.type, signal: isSignal ? col.signal : undefined });
      }
    });
    col.markers.forEach((m) => {
      const row = rowMap.get(m.box);
      if (row !== undefined) cells.push({ row, col: colIndex, value: m.label, isMarker: true });
    });
  });

  const priceLevels = allBoxes.map((idx) => levelFromIndex(idx, anchor, step));
  const last = columns[columns.length - 1];
  const current = levelFromIndex(last.boxes[last.boxes.length - 1], anchor, step);
  const previous = columns.length > 1
    ? levelFromIndex(columns[columns.length - 2].boxes[columns[columns.length - 2].boxes.length - 1], anchor, step)
    : null;
  const reversalIndex = last.type === 'X'
    ? last.boxes[last.boxes.length - 1] - reversalBoxes
    : last.boxes[last.boxes.length - 1] + reversalBoxes;
  const nextReversal = levelFromIndex(reversalIndex, anchor, step);
  const nextReversalPct = current > 0 && nextReversal > 0 ? Math.abs((nextReversal / current - 1) * 100) : null;

  return {
    columns,
    priceLevels,
    cells,
    current,
    previous,
    nextReversal,
    nextReversalPct,
    direction: last.type,
    lastSignal: last.signal || null,
  };
}

function formatNumber(value: number | null, digits = 4) {
  if (value === null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function yearLabelForColumn(columns: PnfColumn[], index: number) {
  const year = columns[index].startDate.getFullYear();
  const prevYear = index > 0 ? columns[index - 1].startDate.getFullYear() : null;
  return year !== prevYear ? String(year) : '';
}

function yearLabelForColumnFromEnd(columns: PnfColumn[], index: number) {
  const year = columns[index].startDate.getFullYear();
  const nextYear = index < columns.length - 1 ? columns[index + 1].startDate.getFullYear() : null;
  return year !== nextYear ? String(year) : '';
}

function App() {
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [dateColumn, setDateColumn] = useState('');
  const [leftColumn, setLeftColumn] = useState('');
  const [rightColumn, setRightColumn] = useState('');
  const [boxSize, setBoxSize] = useState(3.25);
  const [reversalBoxes, setReversalBoxes] = useState(3);
  const [scaleBase, setScaleBase] = useState(277.2932734324);
  const [error, setError] = useState('');

  async function parseBuffer(buffer: ArrayBuffer, fileName: string) {
    const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Row>(sheet, { defval: null, raw: true });
    const columns = rows.length ? Object.keys(rows[0]) : [];
    const nextParsed = { rows, columns, fileName };
    setParsed(nextParsed);
    const detectedDate = detectDateColumn(rows, columns);
    const numericCols = detectNumericColumns(rows, columns, detectedDate);
    setDateColumn(detectedDate);
    setLeftColumn(numericCols[0] || '');
    setRightColumn(numericCols[1] || numericCols[0] || '');
  }

  async function handleFileUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError('');

    try {
      const buffer = await file.arrayBuffer();
      await parseBuffer(buffer, file.name);
    } catch {
      setError('Could not read the file. Upload .xlsx, .xls or .csv.');
    }
  }

  useEffect(() => {
    async function loadSample() {
      try {
        const response = await fetch('/sample/chart(871).xlsx');
        const buffer = await response.arrayBuffer();
        await parseBuffer(buffer, 'chart(871).xlsx');
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
        <div className="brand-sub">Nasdaq-style comparison for two assets, calibrated to your reference file</div>
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
              <span>RS base</span>
              <input type="number" step="0.0001" value={scaleBase} onChange={(e) => setScaleBase(Number(e.target.value) || 277.2932734324)} />
            </label>
            <label>
              <span>Box size (%)</span>
              <input type="number" step="0.01" value={boxSize} onChange={(e) => setBoxSize(Number(e.target.value) || 1)} />
            </label>
            <label>
              <span>Reversal</span>
              <input type="number" step="1" min="1" value={reversalBoxes} onChange={(e) => setReversalBoxes(Math.max(1, Number(e.target.value) || 3))} />
            </label>
          </div>
        )}

        {error && <div className="error-box">{error}</div>}
      </section>

      <section className="panel summary">
        <div className="pair-title">
          <strong>{leftColumn || 'Asset 1'}</strong>
          <span>vs</span>
          <strong>{rightColumn || 'Asset 2'}</strong>
          {pnf?.lastSignal && <span className={`signal-pill ${pnf.lastSignal}`}>{pnf.lastSignal === 'buy' ? 'Buy Signal' : 'Sell Signal'}</span>}
        </div>
        <div className="metrics">
          <div className="metric"><span>RS Calc</span><strong>{formatNumber(currentRaw, 4)}</strong></div>
          <div className="metric"><span>Box size</span><strong>{formatNumber(boxSize, 2)}%</strong></div>
          <div className="metric"><span>Reversal</span><strong>{reversalBoxes}</strong></div>
          <div className="metric"><span>Previous close</span><strong>{formatNumber(previousRaw, 4)}</strong></div>
          <div className="metric"><span>Δ</span><strong className={changeRaw !== null && changeRaw < 0 ? 'down' : 'up'}>{formatNumber(changeRaw, 4)}</strong></div>
          <div className="metric"><span>Δ %</span><strong className={pctChange !== null && pctChange < 0 ? 'down' : 'up'}>{formatNumber(pctChange, 2)}%</strong></div>
          <div className="metric"><span>Next reversal</span><strong>{pnf ? formatNumber(pnf.nextReversal, 4) : '—'}</strong></div>
          <div className="metric"><span>Next reversal %</span><strong>{pnf ? formatNumber(pnf.nextReversalPct, 2) : '—'}%</strong></div>
          <div className="metric"><span>Direction</span><strong>{pnf?.direction || '—'}</strong></div>
        </div>
      </section>

      <section className="panel chart-panel">
        {pnf ? (
          <PnfChart pnf={pnf} />
        ) : (
          <div className="empty-state">Not enough movement yet to build a point & figure chart. Try a smaller percentage box size.</div>
        )}
      </section>

      <section className="panel notes">
        <h3>How it works</h3>
        <p>The app reads two numeric columns from Excel and calculates relative strength as (Asset 1 ÷ Asset 2) × RS Base. The default RS Base is calibrated to your Nasdaq reference so the uploaded sample produces RS Calc ≈ 568.6761.</p>
        <p>The point & figure engine uses a 3.25% percentage box scale with a 100-based box ladder, which is the ladder Nasdaq-style percent charts use for rendering levels on the axis.</p>
      </section>
    </div>
  );
}

function PnfChart({ pnf }: { pnf: PnfResult }) {
  const { columns, priceLevels, cells } = pnf;
  const cellSize = 22;
  const width = Math.max(columns.length * cellSize + 160, 960);
  const height = priceLevels.length * cellSize + 120;
  const cellMap = new Map(cells.map((cell) => [`${cell.row}-${cell.col}`, cell]));

  return (
    <div className="chart-wrap">
      <div className="chart-grid" style={{ width, minHeight: height }}>
        <div className="axis top axis-year" style={{ gridTemplateColumns: `120px repeat(${columns.length}, ${cellSize}px) 120px` }}>
          <div className="axis-corner" />
          {columns.map((col, i) => (
            <div key={`top-year-${i}`} className="axis-year-cell" title={col.startDate.toISOString()}>{yearLabelForColumnFromEnd(columns, i)}</div>
          ))}
          <div className="axis-corner" />
        </div>

        <div className="axis top axis-columns" style={{ gridTemplateColumns: `120px repeat(${columns.length}, ${cellSize}px) 120px` }}>
          <div className="axis-corner" />
          {columns.map((_, i) => (
            <div key={`top-${i}`} className="axis-top-cell">{String(i + 1).padStart(2, '0')}</div>
          ))}
          <div className="axis-corner" />
        </div>

        <div className="body" style={{ gridTemplateColumns: `120px repeat(${columns.length}, ${cellSize}px) 120px` }}>
          {priceLevels.map((level, rowIndex) => (
            <Fragment key={`row-${rowIndex}`}>
              <div className="axis-label">{level.toFixed(4)}</div>
              {columns.map((_, colIndex) => {
                const cell = cellMap.get(`${rowIndex}-${colIndex}`);
                return (
                  <div
                    key={`${rowIndex}-${colIndex}`}
                    className={`grid-cell ${cell?.value === 'X' ? 'cell-x' : ''} ${cell?.value === 'O' ? 'cell-o' : ''} ${cell?.signal === 'buy' ? 'signal-buy' : ''} ${cell?.signal === 'sell' ? 'signal-sell' : ''}`}
                  >
                    {cell ? <span className={cell.isMarker ? 'marker' : ''}>{cell.value}</span> : null}
                  </div>
                );
              })}
              <div className="axis-label">{level.toFixed(4)}</div>
            </Fragment>
          ))}
        </div>

        <div className="axis bottom" style={{ gridTemplateColumns: `120px repeat(${columns.length}, ${cellSize}px) 120px` }}>
          <div className="axis-corner" />
          {columns.map((col, i) => (
            <div key={`bottom-${i}`} className="axis-bottom-cell" title={col.startDate.toISOString()}>{yearLabelForColumn(columns, i)}</div>
          ))}
          <div className="axis-corner" />
        </div>
      </div>
    </div>
  );
}

export default App;
