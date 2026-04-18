import React, { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'

const MONTH_CODES = ['1','2','3','4','5','6','7','8','9','A','B','C']

function parseExcelDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value)
    if (parsed) return new Date(parsed.y, parsed.m - 1, parsed.d)
  }
  const d = new Date(value)
  if (!Number.isNaN(d.getTime())) return d
  return null
}

function formatHeaderNumber(n, digits = 4) {
  if (n == null || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n)
}

function monthCode(date) {
  return MONTH_CODES[date.getMonth()] || ''
}

function inferBoxSize(series) {
  if (!series.length) return 3.25
  const start = series[0].value
  const end = series[series.length - 1].value
  const rangePct = Math.abs((end / start - 1) * 100)
  if (rangePct > 300) return 3.25
  if (rangePct > 150) return 2.5
  return 2.0
}

function normalizeRelativeStrength(rows, assetA, assetB, scaleBase) {
  const common = rows.filter((row) => Number.isFinite(row[assetA]) && Number.isFinite(row[assetB]))
  if (!common.length) return []
  const baseA = common[0][assetA]
  const baseB = common[0][assetB]
  return common.map((row) => ({
    date: row.__date,
    value: ((row[assetA] / baseA) / (row[assetB] / baseB)) * scaleBase,
    assetAValue: row[assetA],
    assetBValue: row[assetB],
  })).filter((row) => Number.isFinite(row.value) && row.value > 0)
}

function buildPctLevels(minVal, maxVal, boxPct) {
  const factor = 1 + boxPct / 100
  const levels = []
  let value = minVal
  levels.push(value)
  let guard = 0
  while (value < maxVal * 1.0000001 && guard < 10000) {
    value *= factor
    levels.push(value)
    guard += 1
  }
  return levels
}

function findLevelIndex(levels, value) {
  let best = 0
  let bestDiff = Infinity
  for (let i = 0; i < levels.length; i += 1) {
    const diff = Math.abs(levels[i] - value)
    if (diff < bestDiff) {
      bestDiff = diff
      best = i
    }
  }
  return best
}

function buildPnFColumns(series, boxPct, reversalBoxes) {
  if (!series.length) return { columns: [], levels: [] }
  const factor = 1 + boxPct / 100
  const minSeries = Math.min(...series.map((d) => d.value)) / (factor ** 4)
  const maxSeries = Math.max(...series.map((d) => d.value)) * (factor ** 4)
  const levels = buildPctLevels(minSeries, maxSeries, boxPct)

  const points = series.map((item) => ({ ...item, level: findLevelIndex(levels, item.value) }))
  if (!points.length) return { columns: [], levels }

  let startIndex = 1
  let direction = null
  while (startIndex < points.length) {
    const diff = points[startIndex].level - points[0].level
    if (Math.abs(diff) >= reversalBoxes) {
      direction = diff > 0 ? 'X' : 'O'
      break
    }
    startIndex += 1
  }
  if (!direction) return { columns: [], levels }

  const columns = []
  const firstEndLevel = points[startIndex].level
  const firstBoxes = []
  if (direction === 'X') {
    for (let i = points[0].level; i <= firstEndLevel; i += 1) firstBoxes.push(i)
  } else {
    for (let i = points[0].level; i >= firstEndLevel; i -= 1) firstBoxes.push(i)
  }

  columns.push({
    type: direction,
    startLevel: points[0].level,
    boxes: firstBoxes,
    high: Math.max(...firstBoxes),
    low: Math.min(...firstBoxes),
    startDate: points[0].date,
    endDate: points[startIndex].date,
    monthMarks: [{ level: points[0].level, label: monthCode(points[0].date), date: points[0].date }],
    signal: null,
  })

  let current = columns[0]
  let lastMarkedMonth = `${points[0].date.getFullYear()}-${points[0].date.getMonth()}`

  for (let p = startIndex + 1; p < points.length; p += 1) {
    const point = points[p]
    const pointMonth = `${point.date.getFullYear()}-${point.date.getMonth()}`

    if (current.type === 'X') {
      if (point.level > current.high) {
        for (let i = current.high + 1; i <= point.level; i += 1) current.boxes.push(i)
        current.high = point.level
        current.endDate = point.date
        if (pointMonth !== lastMarkedMonth) {
          current.monthMarks.push({ level: point.level, label: monthCode(point.date), date: point.date })
          lastMarkedMonth = pointMonth
        }
      } else if (point.level <= current.high - reversalBoxes) {
        const start = current.high - 1
        const end = point.level
        const boxes = []
        for (let i = start; i >= end; i -= 1) boxes.push(i)
        const column = {
          type: 'O',
          startLevel: start,
          boxes,
          high: Math.max(...boxes),
          low: Math.min(...boxes),
          startDate: point.date,
          endDate: point.date,
          monthMarks: [{ level: start, label: monthCode(point.date), date: point.date }],
          signal: null,
        }
        const previousO = [...columns].reverse().find((c) => c.type === 'O')
        if (previousO && column.low < previousO.low) column.signal = 'sell'
        columns.push(column)
        current = column
        lastMarkedMonth = pointMonth
      }
    } else {
      if (point.level < current.low) {
        for (let i = current.low - 1; i >= point.level; i -= 1) current.boxes.push(i)
        current.low = point.level
        current.endDate = point.date
        if (pointMonth !== lastMarkedMonth) {
          current.monthMarks.push({ level: point.level, label: monthCode(point.date), date: point.date })
          lastMarkedMonth = pointMonth
        }
      } else if (point.level >= current.low + reversalBoxes) {
        const start = current.low + 1
        const end = point.level
        const boxes = []
        for (let i = start; i <= end; i += 1) boxes.push(i)
        const column = {
          type: 'X',
          startLevel: start,
          boxes,
          high: Math.max(...boxes),
          low: Math.min(...boxes),
          startDate: point.date,
          endDate: point.date,
          monthMarks: [{ level: start, label: monthCode(point.date), date: point.date }],
          signal: null,
        }
        const previousX = [...columns].reverse().find((c) => c.type === 'X')
        if (previousX && column.high > previousX.high) column.signal = 'buy'
        columns.push(column)
        current = column
        lastMarkedMonth = pointMonth
      }
    }
  }

  return { columns, levels }
}

function prepareRows(rawRows) {
  return rawRows
    .map((row) => {
      const normalized = { ...row }
      const dateKey = Object.keys(row).find((key) => /date/i.test(key)) || Object.keys(row)[0]
      normalized.__date = parseExcelDate(row[dateKey])
      for (const [key, value] of Object.entries(row)) {
        if (key === dateKey) continue
        if (typeof value === 'string') {
          const num = Number(String(value).replace(/,/g, '').trim())
          if (Number.isFinite(num)) normalized[key] = num
        }
      }
      return normalized
    })
    .filter((row) => row.__date instanceof Date)
    .sort((a, b) => a.__date - b.__date)
}

function PnFChart({ columns, levels, series, assetA, assetB, boxPct, reversalBoxes }) {
  const rowCount = levels.length
  const yearMarks = []
  columns.forEach((column, idx) => {
    const y = column.startDate.getFullYear()
    const prevY = idx > 0 ? columns[idx - 1].startDate.getFullYear() : null
    if (idx === 0 || y !== prevY) yearMarks.push({ index: idx, year: y })
  })

  const leftLabels = [...levels].reverse()

  const lastSeries = series.at(-1)
  const lastColumn = columns.at(-1)
  const lastSignal = [...columns].reverse().find((c) => c.signal)?.signal || '—'
  const prevClose = series.at(-2)?.value ?? lastSeries?.value
  const hi = Math.max(...series.map((s) => s.value))
  const lo = Math.min(...series.map((s) => s.value))
  const nextReversal = lastColumn
    ? (lastColumn.type === 'X'
      ? levels[Math.max(lastColumn.high - reversalBoxes, 0)]
      : levels[Math.min(lastColumn.low + reversalBoxes, levels.length - 1)])
    : null

  return (
    <div className="chart-shell">
      <div className="terminal-head">
        <div className="terminal-row terminal-main">
          <div><strong>{assetA}</strong> <span className="vs">vs</span> <strong>{assetB}</strong></div>
          <div className="badge">RS</div>
          <div className="badge">{boxPct.toFixed(3)}</div>
          <div className="badge">{reversalBoxes}</div>
          <div className="badge">Inception - Present</div>
        </div>
        <div className="terminal-row terminal-stats">
          <div>{assetA.replace(/^!/, '')}</div>
          <div><strong>RS Calc:</strong> {formatHeaderNumber(lastSeries?.value, 4)}</div>
          <div><strong>Next Reversal:</strong> {formatHeaderNumber(nextReversal, 4)}</div>
          <div><strong>Previous Close:</strong> {formatHeaderNumber(prevClose, 4)}</div>
          <div><strong>H:</strong> {formatHeaderNumber(hi, 4)}</div>
          <div><strong>L:</strong> {formatHeaderNumber(lo, 4)}</div>
          <div><strong>Last signal:</strong> <span className={lastSignal === 'buy' ? 'buy-text' : lastSignal === 'sell' ? 'sell-text' : ''}>{String(lastSignal).toUpperCase()}</span></div>
        </div>
      </div>

      <div className="pf-wrapper">
        <div className="top-years" style={{ gridTemplateColumns: `repeat(${Math.max(columns.length,1)}, 24px)` }}>
          {Array.from({ length: Math.max(columns.length,1) }).map((_, idx) => {
            const mark = yearMarks.find((m) => m.index === idx)
            return <div key={idx} className="year-cell">{mark ? String(mark.year).slice(-2) : ''}</div>
          })}
        </div>

        <div className="pf-grid-area">
          <div className="y-axis left-axis">
            {leftLabels.map((level, idx) => (
              <div key={idx} className="y-label">{formatHeaderNumber(level, 4)}</div>
            ))}
          </div>

          <div className="pf-grid" style={{ gridTemplateColumns: `repeat(${Math.max(columns.length,1)}, 24px)`, gridTemplateRows: `repeat(${rowCount}, 18px)` }}>
            {columns.map((column, colIdx) => {
              const prevSameType = [...columns.slice(0, colIdx)].reverse().find((c) => c.type === column.type)
              const signalLevel = column.signal === 'buy' ? column.high : column.signal === 'sell' ? column.low : null
              return column.boxes.map((levelIndex, boxIdx) => {
                const row = rowCount - 1 - levelIndex
                const isSignalCell = signalLevel === levelIndex
                const monthMark = column.monthMarks.find((m) => m.level === levelIndex)
                const content = monthMark ? monthMark.label : column.type.toLowerCase()
                const className = [
                  'cell',
                  column.type === 'X' ? 'cell-x' : 'cell-o',
                  isSignalCell ? (column.signal === 'buy' ? 'signal-buy' : 'signal-sell') : '',
                ].join(' ')
                return (
                  <div
                    key={`${colIdx}-${boxIdx}-${levelIndex}`}
                    className={className}
                    style={{ gridColumn: colIdx + 1, gridRow: row + 1 }}
                    title={`${column.type} | ${formatHeaderNumber(levels[levelIndex], 4)} | ${column.startDate.toLocaleDateString()}`}
                  >
                    {content}
                  </div>
                )
              })
            })}
          </div>

          <div className="y-axis right-axis">
            {leftLabels.map((level, idx) => (
              <div key={idx} className="y-label">{formatHeaderNumber(level, 4)}</div>
            ))}
          </div>
        </div>

        <div className="bottom-years" style={{ gridTemplateColumns: `repeat(${Math.max(columns.length,1)}, 24px)` }}>
          {Array.from({ length: Math.max(columns.length,1) }).map((_, idx) => {
            const mark = yearMarks.find((m) => m.index === idx)
            return <div key={idx} className="year-cell">{mark ? String(mark.year).slice(-2) : ''}</div>
          })}
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const [rows, setRows] = useState([])
  const [columns, setColumns] = useState([])
  const [assetA, setAssetA] = useState('')
  const [assetB, setAssetB] = useState('')
  const [scaleBase, setScaleBase] = useState(100)
  const [boxPct, setBoxPct] = useState(3.25)
  const [reversalBoxes, setReversalBoxes] = useState(3)
  const [fileName, setFileName] = useState('sample-chart.xlsx')

  async function loadFromArrayBuffer(buffer, name) {
    const workbook = XLSX.read(buffer, { type: 'array' })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    const json = XLSX.utils.sheet_to_json(sheet, { defval: null })
    const prepared = prepareRows(json)
    setRows(prepared)
    const dataCols = Object.keys(prepared[0] || {}).filter((k) => k !== '__date' && typeof prepared[0][k] === 'number')
    setColumns(dataCols)
    setAssetA(dataCols[0] || '')
    setAssetB(dataCols[1] || dataCols[0] || '')
    setBoxPct(3.25)
    setReversalBoxes(3)
    setScaleBase(100)
    setFileName(name)
  }

  useEffect(() => {
    fetch('/sample-chart.xlsx')
      .then((r) => r.arrayBuffer())
      .then((buffer) => loadFromArrayBuffer(buffer, 'sample-chart.xlsx'))
      .catch(() => {})
  }, [])

  const rsSeries = useMemo(() => {
    if (!assetA || !assetB || !rows.length) return []
    return normalizeRelativeStrength(rows, assetA, assetB, Number(scaleBase) || 100)
  }, [rows, assetA, assetB, scaleBase])

  const chart = useMemo(() => buildPnFColumns(rsSeries, Number(boxPct) || 3.25, Number(reversalBoxes) || 3), [rsSeries, boxPct, reversalBoxes])

  const commonStart = rsSeries[0]
  const commonEnd = rsSeries.at(-1)

  return (
    <div className="page">
      <div className="controls">
        <div className="controls-title">Point & Figure Relative Strength</div>
        <div className="controls-grid">
          <label className="control-file">
            <span>Файл</span>
            <input type="file" accept=".xlsx,.xls,.csv" onChange={async (e) => {
              const file = e.target.files?.[0]
              if (!file) return
              const buffer = await file.arrayBuffer()
              await loadFromArrayBuffer(buffer, file.name)
            }} />
          </label>
          <label>
            <span>Актив 1</span>
            <select value={assetA} onChange={(e) => setAssetA(e.target.value)}>
              {columns.map((col) => <option key={col} value={col}>{col}</option>)}
            </select>
          </label>
          <label>
            <span>Актив 2</span>
            <select value={assetB} onChange={(e) => setAssetB(e.target.value)}>
              {columns.map((col) => <option key={col} value={col}>{col}</option>)}
            </select>
          </label>
          <label>
            <span>Scale Base</span>
            <input type="number" step="1" value={scaleBase} onChange={(e) => setScaleBase(e.target.value)} />
          </label>
          <label>
            <span>Box %</span>
            <input type="number" step="0.01" value={boxPct} onChange={(e) => setBoxPct(e.target.value)} />
          </label>
          <label>
            <span>Reversal</span>
            <input type="number" step="1" value={reversalBoxes} onChange={(e) => setReversalBoxes(e.target.value)} />
          </label>
        </div>
        <div className="formula">RS = ((Asset 1 / first Asset 1) / (Asset 2 / first Asset 2)) × Scale Base</div>
        <div className="meta-row">
          <span><strong>Файл:</strong> {fileName}</span>
          <span><strong>Общая первая точка:</strong> {commonStart ? commonStart.date.toLocaleDateString() : '—'}</span>
          <span><strong>Последняя точка:</strong> {commonEnd ? commonEnd.date.toLocaleDateString() : '—'}</span>
          <span><strong>Строк RS:</strong> {rsSeries.length}</span>
        </div>
      </div>

      {chart.columns.length ? (
        <PnFChart
          columns={chart.columns}
          levels={chart.levels}
          series={rsSeries}
          assetA={assetA}
          assetB={assetB}
          boxPct={Number(boxPct) || 3.25}
          reversalBoxes={Number(reversalBoxes) || 3}
        />
      ) : (
        <div className="empty">Загрузите файл с датой и двумя числовыми рядами.</div>
      )}
    </div>
  )
}
