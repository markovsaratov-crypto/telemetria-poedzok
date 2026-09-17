// src/lib/csv-records.ts — v2.38.2 (миноры ревью F49): общий RFC-4180-парсер
// CSV для импортов (csv + zip). Раньше оба роута делали наивный
// line.split(sep): запятая/точка с запятой внутри кавычек (deviceName, notes)
// сдвигала колонки, а "" (экранированная кавычка) оставалась в значении.
// Здесь — посимвольный state machine: кавычки, экранированные кавычки,
// разделитель и ПЕРЕНОСЫ СТРОК внутри кавычек, CRLF/CR/LF, BOM.
//
// Документированное поведение (аналог unit-проверок, без тестовых файлов):
//  1. 'a,"b,c",d'          sep=',' → ["a","b,c","d"]   — разделитель внутри кавычек НЕ режет поле
//  2. 'a,"b""c",d'                  → ["a",'b"c',"d']  — "" внутри кавычек = одна кавычка
//  3. 'a,"line1\nline2",b'          → ["a","line1\nline2","b"] — перенос внутри кавычек = часть поля
//  4. 'a,b\r\nc,d'                  → 2 записи ["a","b"] и ["c","d"] — CRLF = конец записи
//  5. 'a,"b"x,c'                    → ["a","bx","c"]   — мусор после закрывающей кавычки
//     приклеивается (lenient, как csv-модуль Python); кавычка в середине
//     НЕкавыченного поля — обычный символ
//  6. 'a;"b;c"'            sep=';'  → ["a","b;c"]      — авто-детект ;/,: считаются
//     только НЕквоченные вхождения в первой непустой строке
//  7. 'a, "b"'                      → ["a","b"]        — пробелы ДО открывающей
//     кавычки не мешают кваотированию (частый экспорт '"x", "y"')
// Post-processing — паритет со старым парсером роутов: ячейки .trim(),
// заголовки .trim().toLowerCase(). Отличие (улучшение): одиночные кавычки
// '…' больше НЕ вырезаются из значений (раньше "O'Brien" → "OBrien").
// Пустые записи (все ячейки пусты) отбрасываются — эквивалент старого
// filter(l => l.trim().length > 0).

export interface CsvTable {
  headers: string[]; // нижний регистр, trimmed
  rows: string[][]; // значения trimmed, кавычки уже разворачены
}

/** Авто-детект разделителя: считаем НЕквоченные ';' и ',' в первой непустой
 * строке. ';' победит только при строгом перевесе (как в старых парсерах). */
function detectSeparator(text: string): string {
  const firstLineEnd = text.indexOf("\n");
  const firstLine =
    firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  let semi = 0;
  let comma = 0;
  let inQuotes = false;
  for (let i = 0; i < firstLine.length; i++) {
    const ch = firstLine[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === ";") semi++;
    else if (!inQuotes && ch === ",") comma++;
  }
  return semi > comma ? ";" : ",";
}

export function parseCsvRecords(text: string): CsvTable {
  // BOM от Excel/Numbers ломал первую колонку заголовка (\uFEFFlat) — снимаем
  let s = text;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const sep = detectSeparator(s);

  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false; // кавычка открывает поле, пока оно ещё «пустое»

  const endField = () => {
    record.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        // "" внутри кавычек = экранированная кавычка (RFC-4180 §2.7)
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch; // разделители и \r/\n внутри кавычек — часть поля
      }
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      continue;
    }
    // Пробелы ДО открывающей кавычки ('a, "b"') не мешают кваотированию —
    // частый формат экспорта '"x", "y"'; их отбрасываем (паритет со старым
    // trim+strip всех кавычек)
    if (ch === '"' && field.trim() === "") {
      field = "";
      inQuotes = true;
      fieldStarted = true;
      continue;
    }
    if (ch === sep) {
      endField();
      continue;
    }
    if (ch === "\n") {
      endRecord();
      continue;
    }
    if (ch === "\r") {
      // CRLF: \r пропускаем, \n закроет запись; одиночный \r — тоже конец записи
      if (s[i + 1] === "\n") continue;
      endRecord();
      continue;
    }
    if (!fieldStarted) fieldStarted = true;
    field += ch;
  }
  // Хвост без завершающего перевода строки — не теряем последнюю запись
  if (field !== "" || record.length > 0) endRecord();

  // Пустые записи (аналог старого filter(l => l.trim().length > 0))
  const nonEmpty = records.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };

  const headers = nonEmpty[0].map((h) => h.trim().toLowerCase());
  const rows = nonEmpty.slice(1).map((r) => r.map((c) => c.trim()));
  return { headers, rows };
}
