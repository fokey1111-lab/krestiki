# Point & Figure Relative Strength Site

Готовый проект сайта для построения графика крестиков и ноликов по двум активам в стиле Nasdaq Relative Strength.

## Что умеет
- загружать Excel или CSV
- выбирать колонку даты и два актива
- считать относительную силу: Asset 1 / Asset 2 * Scale Base
- строить Point & Figure chart
- менять Box Size и Reversal
- показывать текущий RS, предыдущий close и уровень следующего reversal

## Запуск
```bash
npm install
npm run dev
```

## Сборка
```bash
npm run build
```

## Структура Excel
Первая колонка — дата, остальные числовые колонки — значения активов.

Пример:
- DateTime
- !AVCBLUE1
- !ALLSEZONPORTFOLIORS

## Деплой
Можно залить на Vercel как обычный Vite-проект.
