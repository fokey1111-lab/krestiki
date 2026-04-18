import { ChangeEvent, Fragment, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';

type Row = Record<string, unknown>;
type ParsedFile = { rows: Row[]; columns: string[]; fileName: string };
type SignalType = 'buy' | 'sell';

type Marker = { level: number; label: string };

type PnfColumn = {
  type: 'X' | 'O';
  boxes: number[];
  startDate: Date;
  endDate: Date;
  markers: Marker[];
  signal?: SignalType;
  signalBox?: number;
  reversalLevel?: number;
};

type PnfCell = {
  row: number;
  col: number;
  value: string;
  isMarker?: boolean;
  signal?: SignalType;
};

type PnfResult = {
  columns: PnfColumn[];
  levels: number[];
  cells: PnfCell[];
  current: number;
  previous: number | null;
  lastSignal: SignalType | null;
  direction: 'X' | 'O' | null;
  nextReversal: number | null;
  chartHigh: number;
  chartLow: number;
};

type NasdaqReference = {
  last?: number;
  rows: { date: string; event: string; eventLevel: number | null; last: number | null }[];
};

const MONTH_MAP = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C'];
const SAMPLE_BASE = 277.2932734023335;
const SAMPLE_LEFT = '!AVCBLUE1';
const SAMPLE_RIGHT = '!ALLSEZONPORTFOLIORS';
const SAMPLE_FILE_NAME = 'chart(871).xlsx';
const DEFAULT_BOX_PERCENT = 3.25;
const DEFAULT_REVERSAL = 3;

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
    const num = Number(value.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function detectDateColumn(rows: Row[], columns: string[]): string {
  return (
    columns
      .map((col) => ({
        col,
        score: rows.slice(0, 50).reduce((count, row) => count + (toDate(row[col]) ? 1 : 0), 0),
      }))
      .sort((a, b) => b.score - a.score)[0]?.col || columns[0] || ''
  );
}

function detectNumericColumns(rows: Row[], columns: string[], dateColumn: string): string[] {
  return columns.filter((col) => col !== dateColumn && rows.slice(0, 50).some((row) => toNumber(row[col]) !== null));
}

function parseRows(fileName: string, rows: Row[]): ParsedFile {
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return { fileName, rows, columns };
}

function parseDelimitedText(text: string): Row[] {
  const workbook = XLSX.read(text, { type: 'string', raw: true, cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json<Row>(sheet, { defval: null, raw: true });
}

function buildRawSeries(rows: Row[], dateCol: string, leftCol: string, rightCol: string) {
  return rows
    .map((row) => {
      const date = toDate(row[dateCol]);
      const left = toNumber(row[leftCol]);
      const right = toNumber(row[rightCol]);
      if (!date || left === null || right === null || left <= 0 || right <= 0) return null;
      return { date, rawRatio: left / right };
    })
    .filter(Boolean)
    .sort((a, b) => a!.date.getTime() - b!.date.getTime()) as { date: Date; rawRatio: number }[];
}

function buildRelativeStrengthSeries(
  rows: Row[],
  dateCol: string,
  leftCol: string,
  rightCol: string,
  rsBase: number,
) {
  return buildRawSeries(rows, dateCol, leftCol, rightCol).map((item) => ({
    date: item.date,
    value: item.rawRatio * rsBase,
  }));
}

function parseNasdaqReference(text: string): NasdaqReference {
  const rows = parseDelimitedText(text);
  const parsed = rows.map((row) => ({
    date: String(row.Date ?? ''),
    event: String(row.Event ?? ''),
    eventLevel: toNumber(row['Event Level']),
    last: toNumber(row.Last),
  }));
  const firstLast = parsed.find((row) => row.last !== null)?.last ?? undefined;
  return { rows: parsed, last: firstLast };
}

function formatNumber(value: number | null, digits = 4) {
  if (value === null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function percentStep(boxPercent: number) {
  return 1 + boxPercent / 100;
}

function logBase(value: number, base: number) {
  return Math.log(value) / Math.log(base);
}

function floorLevel(value: number, step: number) {
  return Number((step ** Math.floor(logBase(value, step))).toFixed(4));
}

function ceilLevel(value: number, step: number) {
  return Number((step ** Math.ceil(logBase(value, step))).toFixed(4));
}

function nextUp(level: number, step: number) {
  return Number((level * step).toFixed(4));
}

function nextDown(level: number, step: number) {
  return Number((level / step).toFixed(4));
}

function labelForDate(date: Date) {
  return MONTH_MAP[date.getMonth()];
}

function levelKey(level: number) {
  return Number(level.toFixed(4));
}

function buildLevels(minLevel: number, maxLevel: number, step: number, padding = 4) {
  let low = minLevel;
  let high = maxLevel;
  for (let i = 0; i < padding; i += 1) {
    low = nextDown(low, step);
    high = nextUp(high, step);
  }
  const levels: number[] = [];
  let current = high;
  const guard = 2500;
  let loops = 0;
  while (current >= low && loops < guard) {
    levels.push(Number(current.toFixed(4)));
    current = nextDown(current, step);
    loops += 1;
  }
  return levels;
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

function createPnf(series: { date: Date; value: number }[], boxPercent: number, reversalBoxes: number): PnfResult | null {
  if (!series.length || boxPercent <= 0 || reversalBoxes < 1) return null;

  const step = percentStep(boxPercent);
  const columns: PnfColumn[] = [];
  let currentColumn: PnfColumn | null = null;
  const anchor = floorLevel(series[0].value, step);

  for (let i = 1; i < series.length; i += 1) {
    const { date, value } = series[i];
    if (!currentColumn) {
      if (value >= nextUp(anchor, step)) {
        const top = floorLevel(value, step);
        const boxes: number[] = [];
        let probe = nextUp(anchor, step);
        while (probe <= top + 1e-9) {
          boxes.push(Number(probe.toFixed(4)));
          probe = nextUp(probe, step);
        }
        if (boxes.length) {
          currentColumn = {
            type: 'X',
            boxes,
            startDate: date,
            endDate: date,
            markers: [{ level: boxes[0], label: labelForDate(date) }],
            reversalLevel: boxes[boxes.length - 1],
          };
          columns.push(currentColumn);
        }
      } else if (value <= nextDown(anchor, step)) {
        const bottom = ceilLevel(value, step);
        const boxes: number[] = [];
        let probe = nextDown(anchor, step);
        while (probe >= bottom - 1e-9) {
          boxes.push(Number(probe.toFixed(4)));
          probe = nextDown(probe, step);
        }
        if (boxes.length) {
          currentColumn = {
            type: 'O',
            boxes,
            startDate: date,
            endDate: date,
            markers: [{ level: boxes[0], label: labelForDate(date) }],
            reversalLevel: boxes[boxes.length - 1],
          };
          columns.push(currentColumn);
        }
      }
      continue;
    }

    if (currentColumn.type === 'X') {
      const top = currentColumn.boxes[currentColumn.boxes.length - 1];
      const nextBox = nextUp(top, step);
      const reversalThreshold = Number((top / step ** reversalBoxes).toFixed(4));

      if (value >= nextBox) {
        const topBox = floorLevel(value, step);
        let probe = nextBox;
        while (probe <= topBox + 1e-9) {
          currentColumn.boxes.push(Number(probe.toFixed(4)));
          probe = nextUp(probe, step);
        }
        currentColumn.endDate = date;
        if (currentColumn.markers[currentColumn.markers.length - 1]?.label !== labelForDate(date)) {
          currentColumn.markers.push({ level: currentColumn.boxes[currentColumn.boxes.length - 1], label: labelForDate(date) });
        }
      } else if (value <= reversalThreshold) {
        const bottomBox = ceilLevel(value, step);
        const boxes: number[] = [];
        let probe = nextDown(top, step);
        while (probe >= bottomBox - 1e-9) {
          boxes.push(Number(probe.toFixed(4)));
          probe = nextDown(probe, step);
        }
        currentColumn = {
          type: 'O',
          boxes,
          startDate: date,
          endDate: date,
          markers: [{ level: boxes[boxes.length - 1], label: labelForDate(date) }],
          reversalLevel: boxes[boxes.length - 1],
        };
        columns.push(currentColumn);
      }
    } else {
      const bottom = currentColumn.boxes[currentColumn.boxes.length - 1];
      const nextBox = nextDown(bottom, step);
      const reversalThreshold = Number((bottom * step ** reversalBoxes).toFixed(4));

      if (value <= nextBox) {
        const bottomBox = ceilLevel(value, step);
        let probe = nextBox;
        while (probe >= bottomBox - 1e-9) {
          currentColumn.boxes.push(Number(probe.toFixed(4)));
          probe = nextDown(probe, step);
        }
        currentColumn.endDate = date;
        if (currentColumn.markers[currentColumn.markers.length - 1]?.label !== labelForDate(date)) {
          currentColumn.markers.push({ level: currentColumn.boxes[currentColumn.boxes.length - 1], label: labelForDate(date) });
        }
      } else if (value >= reversalThreshold) {
        const topBox = floorLevel(value, step);
        const boxes: number[] = [];
        let probe = nextUp(bottom, step);
        while (probe <= topBox + 1e-9) {
          boxes.push(Number(probe.toFixed(4)));
          probe = nextUp(probe, step);
        }
        currentColumn = {
          type: 'X',
          boxes,
          startDate: date,
          endDate: date,
          markers: [{ level: boxes[boxes.length - 1], label: labelForDate(date) }],
          reversalLevel: boxes[boxes.length - 1],
        };
        columns.push(currentColumn);
      }
    }
  }

  if (!columns.length) return null;

  detectSignals(columns);
  const allBoxes = columns.flatMap((column) => column.boxes);
  const chartLow = Math.min(...allBoxes);
  const chartHigh = Math.max(...allBoxes);
  const levels = buildLevels(chartLow, chartHigh, step, 4);
  const rowMap = new Map<number, number>(levels.map((level, index) => [levelKey(level), index]));
  const cells: PnfCell[] = [];

  columns.forEach((column, colIndex) => {
    column.boxes.forEach((box) => {
      const row = rowMap.get(levelKey(box));
      if (row === undefined) return;
      const isSignal = column.signalBox !== undefined && levelKey(column.signalBox) === levelKey(box);
      cells.push({ row, col: colIndex, value: column.type, signal: isSignal ? column.signal : undefined });
    });
    column.markers.forEach((marker) => {
      const row = rowMap.get(levelKey(marker.level));
      if (row === undefined) return;
      cells.push({ row, col: colIndex, value: marker.label, isMarker: true });
    });
  });

  const lastColumn = columns[columns.length - 1];
  const current = lastColumn.boxes[lastColumn.boxes.length - 1];
  const previous = series.length > 1 ? series[series.length - 2].value : null;
  const nextReversal =
    lastColumn.type === 'X'
      ? Number((current / step ** reversalBoxes).toFixed(4))
      : Number((current * step ** reversalBoxes).toFixed(4));

  return {
    columns,
    levels,
    cells,
    current,
    previous,
    lastSignal: lastColumn.signal ?? null,
    direction: lastColumn.type,
    nextReversal,
    chartHigh,
    chartLow,
  };
}

function buildYearGroups(columns: PnfColumn[]) {
  const groups: { year: number; start: number; span: number }[] = [];
  columns.forEach((column, index) => {
    const year = column.startDate.getFullYear();
    const last = groups[groups.length - 1];
    if (!last || last.year !== year) groups.push({ year, start: index, span: 1 });
    else last.span += 1;
  });
  return groups;
}

function extractWorkbookRows(buffer: ArrayBuffer, fileName: string): ParsedFile {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv')) {
    const text = new TextDecoder('utf-8').decode(buffer);
    return parseRows(fileName, parseDelimitedText(text));
  }
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true, raw: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Row>(sheet, { defval: null, raw: true });
  return parseRows(fileName, rows);
}

function App() {
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [dateColumn, setDateColumn] = useState('');
  const [leftColumn, setLeftColumn] = useState('');
  const [rightColumn, setRightColumn] = useState('');
  const [boxPercent, setBoxPercent] = useState(DEFAULT_BOX_PERCENT);
  const [reversalBoxes, setReversalBoxes] = useState(DEFAULT_REVERSAL);
  const [rsBase, setRsBase] = useState(100);
  const [reference, setReference] = useState<NasdaqReference | null>(null);
  const [error, setError] = useState('');

  async function loadParsedFile(fileName: string, buffer: ArrayBuffer) {
    const nextParsed = extractWorkbookRows(buffer, fileName);
    setParsed(nextParsed);
    const detectedDate = detectDateColumn(nextParsed.rows, nextParsed.columns);
    const numericColumns = detectNumericColumns(nextParsed.rows, nextParsed.columns, detectedDate);
    const nextLeft = numericColumns[0] || '';
    const nextRight = numericColumns[1] || numericColumns[0] || '';
    setDateColumn(detectedDate);
    setLeftColumn(nextLeft);
    setRightColumn(nextRight);

    if (fileName === SAMPLE_FILE_NAME && nextLeft === SAMPLE_LEFT && nextRight === SAMPLE_RIGHT) {
      setRsBase(SAMPLE_BASE);
    }
  }

  async function handleFileUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setError('');
      const buffer = await file.arrayBuffer();
      await loadParsedFile(file.name, buffer);
    } catch {
      setError('Could not read the data file. Upload .xlsx, .xls or .csv.');
    }
  }

  async function handleReferenceUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsedReference = parseNasdaqReference(text);
      setReference(parsedReference);
    } catch {
      setError('Could not read the Nasdaq reference CSV.');
    }
  }

  useEffect(() => {
    async function loadSample() {
      try {
        const [sampleResponse, referenceResponse] = await Promise.all([
          fetch('/sample/chart(871).xlsx'),
          fetch('/reference/!AVCBLUE1 Nasdaq Dorsey Wright(8).csv'),
        ]);
        const [sampleBuffer, referenceText] = await Promise.all([sampleResponse.arrayBuffer(), referenceResponse.text()]);
        await loadParsedFile(SAMPLE_FILE_NAME, sampleBuffer);
        setReference(parseNasdaqReference(referenceText));
      } catch {
        // ignore bootstrap issues
      }
    }
    loadSample();
  }, []);

  const numericColumns = useMemo(() => {
    if (!parsed) return [];
    return detectNumericColumns(parsed.rows, parsed.columns, dateColumn);
  }, [parsed, dateColumn]);

  const rawSeries = useMemo(() => {
    if (!parsed || !dateColumn || !leftColumn || !rightColumn) return [];
    return buildRawSeries(parsed.rows, dateColumn, leftColumn, rightColumn);
  }, [parsed, dateColumn, leftColumn, rightColumn]);

  useEffect(() => {
    if (!reference?.last || !rawSeries.length) return;
    const latestRaw = rawSeries[rawSeries.length - 1].rawRatio;
    if (!Number.isFinite(latestRaw) || latestRaw <= 0) return;
    if (Math.abs(rsBase - SAMPLE_BASE) < 1e-9 && reference.last === SAMPLE_BASE) return;
  }, [reference, rawSeries, rsBase]);

  const autoCalibratedBase = useMemo(() => {
    if (!reference?.last || !rawSeries.length) return null;
    const latestRaw = rawSeries[rawSeries.length - 1].rawRatio;
    if (!Number.isFinite(latestRaw) || latestRaw <= 0) return null;
    return reference.last / latestRaw;
  }, [reference, rawSeries]);

  const effectiveBase = autoCalibratedBase ?? rsBase;

  const rsSeries = useMemo(() => {
    if (!parsed || !dateColumn || !leftColumn || !rightColumn) return [];
    return buildRelativeStrengthSeries(parsed.rows, dateColumn, leftColumn, rightColumn, effectiveBase);
  }, [parsed, dateColumn, leftColumn, rightColumn, effectiveBase]);

  const pnf = useMemo(() => createPnf(rsSeries, boxPercent, reversalBoxes), [rsSeries, boxPercent, reversalBoxes]);

  const currentRaw = rsSeries.length ? rsSeries[rsSeries.length - 1].value : null;
  const previousRaw = rsSeries.length > 1 ? rsSeries[rsSeries.length - 2].value : null;
  const changeRaw = currentRaw !== null && previousRaw !== null ? currentRaw - previousRaw : null;
  const pctChange = currentRaw !== null && previousRaw !== null && previousRaw !== 0 ? (changeRaw / previousRaw) * 100 : null;
  const nextReversalPct = currentRaw !== null && pnf?.nextReversal ? Math.abs((currentRaw - pnf.nextReversal) / currentRaw) * 100 : null;

  return (
    <div className="app-shell">
      <header className="topline panel slim">
        <div className="headline-left">
          <strong>{leftColumn || 'Asset 1'}</strong>
          <span>vs</span>
          <strong>{rightColumn || 'Asset 2'}</strong>
          <span>Scale:</span>
          <strong>{formatNumber(boxPercent, 3)}%</strong>
          <span>{rsSeries.length ? rsSeries[rsSeries.length - 1].date.toLocaleString('en-GB', { hour12: false }) : ''}</span>
        </div>
        <div className="headline-right">Image Source: NASDAQ DORSEY WRIGHT</div>
      </header>

      <section className="panel controls">
        <div className="upload-row">
          <label className="upload-box">
            <span>Upload Excel / CSV with two assets</span>
            <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFileUpload} />
          </label>
          <label className="upload-box secondary">
            <span>Upload Nasdaq reference CSV</span>
            <input type="file" accept=".csv" onChange={handleReferenceUpload} />
          </label>
          <div className="loaded-name">{parsed ? `Loaded: ${parsed.fileName}` : 'No data file loaded'}</div>
        </div>

        {parsed && (
          <div className="control-grid">
            <label>
              <span>Date column</span>
              <select value={dateColumn} onChange={(e) => setDateColumn(e.target.value)}>
                {parsed.columns.map((column) => (
                  <option key={column} value={column}>{column}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Asset 1</span>
              <select value={leftColumn} onChange={(e) => setLeftColumn(e.target.value)}>
                {numericColumns.map((column) => (
                  <option key={column} value={column}>{column}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Asset 2</span>
              <select value={rightColumn} onChange={(e) => setRightColumn(e.target.value)}>
                {numericColumns.map((column) => (
                  <option key={column} value={column}>{column}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Box size (%)</span>
              <input type="number" step="0.001" value={boxPercent} onChange={(e) => setBoxPercent(Number(e.target.value) || DEFAULT_BOX_PERCENT)} />
            </label>
            <label>
              <span>Reversal boxes</span>
              <input type="number" min="1" step="1" value={reversalBoxes} onChange={(e) => setReversalBoxes(Math.max(1, Number(e.target.value) || DEFAULT_REVERSAL))} />
            </label>
            <label>
              <span>RS base (manual)</span>
              <input type="number" step="0.0001" value={rsBase} onChange={(e) => setRsBase(Number(e.target.value) || 100)} />
            </label>
          </div>
        )}

        {autoCalibratedBase && (
          <div className="calibration-box">
            Auto-calibration from Nasdaq reference is active. Effective RS base: <strong>{formatNumber(autoCalibratedBase, 6)}</strong>
          </div>
        )}

        {error && <div className="error-box">{error}</div>}
      </section>

      <section className="panel summary-strip">
        <div className="summary-line">
          <span>{leftColumn || 'Asset 1'}</span>
          <strong>RS Calc: {formatNumber(currentRaw, 4)}</strong>
          <strong>Next Reversal: {formatNumber(nextReversalPct, 2)}%</strong>
          <span>Previous Close: {formatNumber(previousRaw, 4)}</span>
          <span className={changeRaw !== null && changeRaw < 0 ? 'down' : 'up'}>{formatNumber(changeRaw, 4)} ({formatNumber(pctChange, 2)}%)</span>
          <span>H: {currentRaw !== null ? formatNumber(currentRaw, 4) : '—'}</span>
          <span>L: {currentRaw !== null ? formatNumber(currentRaw, 4) : '—'}</span>
        </div>
      </section>

      <section className="panel chart-panel">
        {pnf ? <PnfChart pnf={pnf} /> : <div className="empty-state">Not enough movement to build a chart yet.</div>}
      </section>

      <section className="panel note-box">
        <p>
          The engine now uses a percentage point-and-figure grid like Nasdaq Dorsey Wright: raw RS is calculated as Asset 1 ÷ Asset 2,
          then scaled by an RS base, placed on a fixed geometric grid, and reversed only after a full {reversalBoxes}-box move from the latest extreme.
        </p>
      </section>
    </div>
  );
}

function PnfChart({ pnf }: { pnf: PnfResult }) {
  const { columns, levels, cells } = pnf;
  const cellSize = 22;
  const leftAxis = 110;
  const rightAxis = 110;
  const yearGroups = buildYearGroups(columns);
  const cellMap = new Map(cells.map((cell) => [`${cell.row}-${cell.col}`, cell]));
  const chartWidth = leftAxis + rightAxis + columns.length * cellSize;

  return (
    <div className="chart-wrap">
      <div className="chart-grid" style={{ minWidth: Math.max(chartWidth, 1120) }}>
        <div className="year-band" style={{ gridTemplateColumns: `${leftAxis}px repeat(${columns.length}, ${cellSize}px) ${rightAxis}px` }}>
          <div />
          <div className="year-band-inner" style={{ gridColumn: `2 / span ${columns.length}` }}>
            {yearGroups.map((group) => (
              <div
                key={`top-${group.year}-${group.start}`}
                className="year-group"
                style={{ gridColumn: `${group.start + 1} / span ${group.span}` }}
              >
                {String(group.year).slice(-2)}
              </div>
            ))}
          </div>
          <div />
        </div>

        <div className="body-grid" style={{ gridTemplateColumns: `${leftAxis}px repeat(${columns.length}, ${cellSize}px) ${rightAxis}px` }}>
          {levels.map((level, rowIndex) => (
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

        <div className="year-band bottom" style={{ gridTemplateColumns: `${leftAxis}px repeat(${columns.length}, ${cellSize}px) ${rightAxis}px` }}>
          <div />
          <div className="year-band-inner" style={{ gridColumn: `2 / span ${columns.length}` }}>
            {yearGroups.map((group) => (
              <div
                key={`bottom-${group.year}-${group.start}`}
                className="year-group"
                style={{ gridColumn: `${group.start + 1} / span ${group.span}` }}
              >
                {String(group.year).slice(-2)}
              </div>
            ))}
          </div>
          <div />
        </div>
      </div>
    </div>
  );
}

export default App;
