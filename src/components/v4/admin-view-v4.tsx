// src/components/v4/admin-view-v4.tsx — вкладка Админ v4.
// Комбинированная: A1-A4 v4 (Параметры/Сессии/Качество/Пайплайн)
// + legacy блоки из текущего AdminPanel (Состояние системы / Настройки
// маршрутизации / GitHub Backup / Резервные копии / Requeue).
// + A5 Импорт (CsvImport + ZipImport), как согласовано.

"use client";

import * as React from "react";
import {
  Activity,
  Cpu,
  Server,
  Database,
  HardDrive,
  Hash,
  Zap,
  ShieldCheck,
  RotateCcw,
  Github,
  Settings as SettingsIcon,
  Upload,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Radio,
  Copy,
  Send,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  useHealth,
  useStats,
  useBackups,
  useCreateBackup,
  useRequeueJob,
  useSettings,
  useUpdateSetting,
  useGitHubBackups,
  useCreateGitHubBackup,
  useSessions,
  INGEST_OUTCOME_RU,
  BACKUP_STATUS_RU,
  type StatsResponse,
} from "@/lib/hooks";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtDate, fmtBytes, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { bindTips } from "./use-v4-tipbox";
import { CsvImport } from "@/components/csv-import";
import { ZipImport } from "@/components/zip-import";

// Версии документов (v2.14.0): синхронно с шапками docs/METHODOLOGY.md и docs/ADMIN_SPEC.md.
// При следующем релизе доков обновить здесь + строки изменений ниже + шапки файлов в docs/
// (методология не менялась с v2.10.4 — prev у неё остаётся v2.9).
const DOCS = {
  methodology: "v2.10.4 · 31.08",
  methodologyPrev: "v2.9 · 29.08",
  spec: "v2.17.0 · 04.09",
  specPrev: "v2.16.0 · 04.09",
} as const;

export function AdminViewV4() {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (ref.current) bindTips(ref.current);
  });

  return (
    <div ref={ref}>
      <A1ParamsBlock />
      <A2SessionsBlock />
      <A3QualitySummaryBlock />
      <A4PipelineBlock />
      <A5ImportBlock />
      <A6IngestDiagBlock />

      {/* === Разделитель legacy === */}
      <div className="legacy-grid">
        <div className="sec-head" style={{ marginTop: 0 }}>
          <span className="sec-num">L</span>
          <span className="sec-title">Служебные блоки (legacy)</span>
          <span className="sec-sub">live-данные + runtime-overridable</span>
        </div>

        <SystemInfoLegacyCard />
        <RoutingSettingsLegacyCard />
        <div className="legacy-grid-2col">
          <GitHubBackupLegacyCard />
          <BackupsLegacyCard />
        </div>
        <RequeueLegacyCard />
      </div>

      <div className="toast">
        <b>Служебная вкладка.</b> Параметры и диагностика соответствуют разделам методики (параметры расчёта, идемпотентность, кэширование, цепочка маршрутизации). Блок A1 — константы расчёта (совпадают с методологией); A2–A4 — справочные ПРИМЕРЫ, не связанные с БД (live-данные — в блоках A6 и L). Подключение A2–A4 к реальным API — в бэклоге.
      </div>
    </div>
  );
}

// === A1: Параметры системы ===
function A1ParamsBlock() {
  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">A1</span>
        <span className="sec-title">Параметры системы</span>
        <span className="sec-sub">константы расчёта · параметры методики</span>
      </div>
      <div className="card">
        <div className="param-grid">
          <div>
            <div className="param">
              <span>Порог разрыва записи</span>
              <b>30 сек</b>
            </div>
            <div className="param">
              <span>
                Гистерезис движения
                <small>вход в движение / выход</small>
              </span>
              <b>5 / 2 км/ч</b>
            </div>
            <div className="param">
              <span>Резкое торможение / разгон</span>
              <b>±10 км/ч/сек</b>
            </div>
            <div className="param">
              <span>
                Манёвр на высокой скорости
                <small>Δ курса · окно · скорость</small>
              </span>
              <b>45° · 5 сек · 60 км/ч</b>
            </div>
            <div className="param">
              <span>Порог пробки (сегмент)</span>
              <b>severity &lt; 0,5</b>
            </div>
            <div className="param">
              <span>Крейсерская скорость</span>
              <b>&gt; 60 км/ч</b>
            </div>
          </div>
          <div>
            <div className="param">
              <span>Пробка по скорости (точки)</span>
              <b>&lt; 10 км/ч</b>
            </div>
            <div className="param">
              <span>
                EcoScore · базлайны CAP
                <small>торможение / разгон / рывок</small>
              </span>
              <b>0,5 / 0,4 / 0,3</b>
            </div>
            <div className="param">
              <span>EcoScore · веса компонентов</span>
              <b>0,45 / 0,30 / 0,25</b>
            </div>
            <div className="param">
              <span>baselineVersion</span>
              <b>2026-08-01 · n42</b>
            </div>
            <div className="param">
              <span>Viterbi · σ / β</span>
              <b>5 м / 5 м</b>
            </div>
            <div className="param">
              <span>Мин. корпус калибровки</span>
              <b>30 сессий</b>
            </div>
          </div>
        </div>
      </div>
      {/* v2.10.4: версии документации + журнал изменений (новое — цветом, прежнее — зачёркнуто) */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="doc-grid">
          <div>
            <div className="param">
              <span>
                Методология
                <small>
                  docs/METHODOLOGY.md · <s>было {DOCS.methodologyPrev}</s>
                </small>
              </span>
              <b className="c-plum">{DOCS.methodology}</b>
            </div>
            <div className="param">
              <span>
                Спецификация администратора
                <small>
                  docs/ADMIN_SPEC.md · <s>было {DOCS.specPrev}</s>
                </small>
              </span>
              <b className="c-plum">{DOCS.spec}</b>
            </div>
          </div>
          <div className="doc-log">
            <div className="doc-log-cap">Изменения против v2.9 · новое — цветом, прежнее — зачёркнуто</div>
            <ul>
              <li>
                <b className="c-plum">§4.2 / §4.3</b> дистанция и средняя скорость —{" "}
                <b className="c-plum">по активной части (§4.11)</b>; <s>по всей записи</s> → rawDistanceM
              </li>
              <li>
                <b className="c-plum">§6.2 / §6.3</b> факт план-факта ={" "}
                <b className="c-plum">ActiveDuration</b>; <s>длительность всей записи</s>
              </li>
              <li>
                <b className="c-plum">§6.5</b> share-страница —{" "}
                <b className="c-plum">серверные KPI</b> по методологии (согласована с админкой)
              </li>
              <li>
                <b className="c-plum">спека</b> hardening: CORS, маскирование секретов, лимиты импорта,
                timing-safe токены, <s>точки accuracy без фильтра</s> → приём при ≤ 100 м
              </li>
              <li>
                <b className="c-plum">UI</b> разрывы <s>1323 сек</s> → 22 мин; точность AvgSpeed в API{" "}
                <b className="c-plum">0,001 м/с</b> (поверхности сходятся)
              </li>
              <li>
                <b className="c-plum">спека v2.10.6</b> диагностика канала приёма: каждая попытка инжеста
                (включая <s>«тихие» 200 OK без GPS-точек</s>) фиксируется и видна в АДМИН → L1
              </li>
              <li>
                <b className="c-plum">спека v2.10.7</b> расширенный парсер инжеста (coords/position/gps,
                ISO-время) + <b className="c-plum">образец структуры</b> нераспознанных батчей в L1;
                rate-limit: <s>GET-список бэкапов 1/час</s> → 60/мин (429 «Слишком много запросов»)
              </li>
              <li>
                <b className="c-plum">спека v2.10.8</b> нативный формат Sensor Logger
                (payload: {"[{name, time, values}]"}, нс-таймстемпы) распознан; гистограмма сенсоров
                в образце + <b className="c-plum">полный дамп</b> нераспознанного батча (кнопка в L1)
              </li>
              <li>
                <b className="c-plum">спека v2.11.0</b> аудит кода+UX: системный фикс дат
                (<s>числа epoch</s> → ISO), пагинация, идемпотентность инжеста, автобэкап-кроны
                (<s>401</s> → работают), честные состояния загрузки/ошибок в интерфейсе
              </li>
              <li>
                <b className="c-plum">спека v2.12.0</b> UX-ревью: <s>кнопка «Месяц»</s> → 4 периода;
                идентификация поездок <b className="c-plum">по адресу конечной точки</b> (Nominatim
                + кэш); единый счётчик GPS-точек (<s>15 266/15 155/15 148</s> → сходятся) ;
                <s>«−66,6 балла»</s> → clamp штрафов EcoScore; <s>«39 РЕЗКО» на стоянке</s> →
                медиан-фильтр GPS-выбросов; «Тяжёлые участки» и «Частые маршруты» уважают период
              </li>
              <li>
                <b className="c-plum">спека v2.13.0</b> пять дефектов владельца: <s>«Рекорд скорости —»</s> →
                живой §4.5 MaxSpeedAllTime (новый <b>/api/stats/speed-record</b>); <s>левая половина G-G пуста</s> →
                знаковый latA (влево/вправо); <s>8 событий при 42 у методологии</s> → порог §7.1 10 км/ч/с
                (было 10 м/с² ≈ 1g); <s>«+105 мин» vs «−39,7 мин»</s> → FIX-C2 доведён до блока 04;
                <s>«-5,987384005838807%»</s> → 2 знака после запятой; скорость карты — нормализация
                (B-4) + км/ч-пороги (сдвиг 3,6×)
              </li>
              <li>
                <b className="c-plum">спека v2.14.0</b> целостность поездок и живой список:
                <b> Ф1</b> — соседние записи одного устройства с паузой &lt; 10 минут склеиваются в
                одну карточку-поездку (кейс 02.09: <s>вечерняя поездка = 5 кусков</s> → 1 поездка
                с раскладкой на записи и паузами между ними); <b>Ф2</b> — список поездок обновляется
                каждые 30 сек при активной вкладке, статистика идущей записи — каждые 15 сек,
                чип «идёт запись» пульсирует; <b>Ф3</b> — воркер закрывает зависшие recording-сессии
                после 10 минут тишины (metric <b>recording_reaped_total</b>, финализация общая с
                инжестом в <b>session-finalize.ts</b>)
              </li>
              <li>
                <b className="c-plum">спека v2.14.1</b> лимит чтений «Поездок»: открытие вкладки со
                склейкой шлёт пачку stats+geocode по всем записям — всплеск с ретраями превышал
                общий 60/мин (<s>тосты «Повторите через 1 мин»</s>, статы карточек «—»). Дешёвые
                GET-чтения (список, статы записи, геокод) выделены в <b>read</b>-скоп
                <b>240/мин</b> (env <b>RATE_LIMIT_MAX_READ</b>); тяжёлые чтения и мутации — как было
              </li>
              <li>
                <b className="c-plum">спека v2.14.2</b> защита от всплесков UI: события/трек периода
                тоже в <b>read</b>-скопе (период-агрегат аналитики качает их пачкой по определению);
                клиентский <b>семафор 6 GET</b> (api-client) — «Аналитика»+«Поездки» больше не
                выпускают десятки параллельных запросов (<s>пик памяти 512 МБ инстанса — краш 03.09</s>)
              </li>
              <li>
                <b className="c-plum">спека v2.17.0</b> батч-статс: <b>GET /api/stats/batch?ids=</b> — статистика
                до 50 записей одним запросом (формат идентичен поштучному роуту, <s>25 записей =
                25 запросов = 40–60 с загрузки «Поездок»</s>); весь конвейер — единый модуль
                <b>session-stats.ts</b> для обоих роутов (QA: 25/25 сессий deep-equality, 0 расхождений);
                клиент просеивает ответ в кэш — карточки не ходят по сети (live-поллинг 15с сохранён);
                период-агрегат «Аналитики» — батчем вместо ≤30 параллельных. «Батя» в v2.15.0 —
                моё прочтение «батч»; эндпоинт оставлен
              </li>
              <li>
                <b className="c-plum">спека v2.16.0</b> системная чистка бекенда: критичные фиксы
                (<s>ExportJob-«вечные 202» из-за несуществующей колонки updatedAt</s>, потеря батчей
                при сбое инжеста, дубли TrafficJob от трёх финализаторов, разрезание поездок по
                серверному wall-clock), corpus-калибровка EcoScore — <b>один JOIN вместо N+1</b>,
                poll экспортов без перелива точек, O(n²)→O(n) в метриках; дедупликация
                (SQL-строители db.ts, единые haversine/median/пороги/парсер времени);
                <b>удалены 11 мёртвых эндпоинтов</b> и мёртвые хуки; «сегодня» — везде в tz клиента;
                вайлист колонок restore, allow-list настроек, retention чистит IngestMessage/геокэш.
                Формулы метрик и цифры НЕ менялись.
              </li>
              <li>
                <b className="c-plum">спека v2.15.0</b> синхронизация параметров «Поездок» и «Аналитики» +
                батя-статс: карточка склеенной поездки показывает <b>Σ длительностей записей</b>
                (§4.1 — как KPI «Длительность»; <s>span «от старта до финиша» раздувал «2 ч»
                до «4 ч 51 мин»</s> — теперь это отдельная строка), <b>«в поездке»</b> = Σ активных
                частей (§4.11 — как «в поездках» в шапке), ср. скорость = Σдист/Σактивных
                (§4.3, FIX-C1 — <s>было Σдист/Σдвижения</s>), EcoScore — взвешенное по активной
                длительности; сводка сверху — «в поездках» и плавность теми же формулами.
                Новый <b>GET /api/stats/batya</b>: всё время / сегодня / 7д / 30д + рекорды +
                уровень бати (кэш 5 мин, read-скоп, ?tzOffsetMin для «сегодня» в tz клиента)
              </li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

// === A2: Сессии · качество и привязка ===
function A2SessionsBlock() {
  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">A2</span>
        <span className="sec-title">Сессии · качество и привязка</span>
        {/* v2.11.0 (U-5): постоянная метка — числа ниже ПРИМЕРЫ, не из БД */}
        <span className="demo-chip">демо-данные</span>
        <span className="sec-sub">справочные примеры · не из БД</span>
      </div>
      <div className="card adm-tbl-wrap">
        <table className="adm-tbl">
          <thead>
            <tr>
              <th>Сессия</th>
              <th>routeId</th>
              <th>Точки</th>
              <th>Полн.</th>
              <th>Надёжн.</th>
              <th>Гео-охват (BBox)</th>
              <th>План</th>
              <th>Дубль</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>28 авг · 14:23</td>
              <td className="mono">a3b8c1f2e9d04b77</td>
              <td className="mono">18 740</td>
              <td className="mono">92%</td>
              <td className="mono c-plum">0,91</td>
              <td className="mono">55.72–78 / 37.51–61</td>
              <td className="mono">2ГИС</td>
              <td className="mono">—</td>
            </tr>
            <tr>
              <td>28 авг · 08:12</td>
              <td className="mono">a3b8c1f2e9d04b77</td>
              <td className="mono">18 312</td>
              <td className="mono">94%</td>
              <td className="mono c-plum">0,93</td>
              <td className="mono">55.72–78 / 37.51–61</td>
              <td className="mono">2ГИС</td>
              <td className="mono">—</td>
            </tr>
            <tr>
              <td>27 авг · 19:40</td>
              <td className="mono">7d2e4a91c6f13e08</td>
              <td className="mono">3 981</td>
              <td className="mono">89%</td>
              <td className="mono c-plum">0,88</td>
              <td className="mono">55.75–80 / 37.58–68</td>
              <td className="mono">2ГИС</td>
              <td className="mono">—</td>
            </tr>
            <tr>
              <td>27 авг · 07:55</td>
              <td className="mono">a3b8c1f2e9d04b77</td>
              <td className="mono">19 205</td>
              <td className="mono">91%</td>
              <td className="mono c-amber">0,79</td>
              <td className="mono">55.72–78 / 37.51–61</td>
              <td className="mono">OSRM</td>
              <td className="mono">—</td>
            </tr>
            <tr>
              <td>26 авг · 18:20</td>
              <td className="mono">b1c9e8d45a27f6c3</td>
              <td className="mono">9 148</td>
              <td className="mono">96%</td>
              <td className="mono c-plum">0,95</td>
              <td className="mono">55.73–85 / 37.40–52</td>
              <td className="mono">2ГИС</td>
              <td className="mono">—</td>
            </tr>
            <tr>
              <td>25 авг · 09:05</td>
              <td className="mono">b1c9e8d45a27f6c3</td>
              <td className="mono">8 970</td>
              <td className="mono">93%</td>
              <td className="mono c-plum">0,90</td>
              <td className="mono">55.73–85 / 37.40–52</td>
              <td className="mono">гаверсинус</td>
              <td className="mono">1 откл.</td>
            </tr>
          </tbody>
        </table>
        <p className="pf-note" style={{ marginTop: 11 }}>
          routeId = sha256(snap-to-grid старта : snap-to-grid финиша : топология маршрута), первые 16 символов — группирует концептуально одинаковые маршруты (10.0). Дубликаты отклоняются по clientId до расчёта метрик (3.4). Гео-охват — BoundingBox (8.1) по крайним точкам записи.
        </p>
      </div>
    </section>
  );
}

// === A3: Сводка качества данных ===
function A3QualitySummaryBlock() {
  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">A3</span>
        <span className="sec-title">Сводка качества данных</span>
        {/* v2.11.0 (U-5): постоянная метка — числа ниже ПРИМЕРЫ, не из БД */}
        <span className="demo-chip">демо-данные</span>
        <span className="sec-sub">справочные примеры · не из БД</span>
      </div>
      <div className="card">
        <div className="stats-grid" style={{ marginTop: 0 }}>
          <div className="stat">
            <div className="v c-plum">87%</div>
            <div className="l">сессий с высокой надёжностью (&gt;0,85)</div>
          </div>
          <div className="stat">
            <div className="v">
              7,8 <span className="u">м</span>
            </div>
            <div className="l">средняя точность P90 по парку сессий</div>
          </div>
          <div className="stat">
            <div className="v">1,7/с</div>
            <div className="l">средняя плотность точек</div>
          </div>
          <div className="stat">
            <div className="v c-amber">9</div>
            <div className="l">сессий требуют внимания (&lt;0,6)</div>
          </div>
        </div>
        <p className="pf-note" style={{ marginTop: 12 }}>
          Худшая запись: 14 авг · 21:07 — полнота 64%, два разрыва по 40+ сек, дрейф на стоянке. Метрики этой сессии помечены низким индексом доверия и исключены из сравнительных агрегатов маршрута.
        </p>
      </div>
    </section>
  );
}

// === A4: Пайплайн маршрутизации ===
function A4PipelineBlock() {
  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">A4</span>
        <span className="sec-title">Пайплайн маршрутизации</span>
        {/* v2.11.0 (U-5): постоянная метка — числа ниже ПРИМЕРЫ, не из БД */}
        <span className="demo-chip">демо-данные</span>
        <span className="sec-sub">источники плана · справочные примеры, не из БД</span>
      </div>
      <div className="card">
        <div className="pipe-bar">
          <i style={{ width: "76%", background: "#8E2D4E" }} title="2ГИС carrouting 6.0.0" />
          <i style={{ width: "17%", background: "#A85D8A" }} title="OSRM Demo Server" />
          <i style={{ width: "7%", background: "#D9C6D2" }} title="Гаверсинус 40 км/ч" />
        </div>
        <div className="pipe-leg">
          <span>
            <em style={{ background: "#8E2D4E" }} />
            2ГИС · 70 сессий
          </span>
          <span>
            <em style={{ background: "#A85D8A" }} />
            OSRM · 16 сессий
          </span>
          <span>
            <em style={{ background: "#D9C6D2" }} />
            гаверсинус · 6 сессий
          </span>
        </div>
        <div className="stats-grid" style={{ marginTop: 0 }}>
          <div className="stat">
            <div className="v c-plum">71%</div>
            <div className="l">попаданий в кэш маршрутов (14)</div>
          </div>
          <div className="stat">
            <div className="v">412 мс</div>
            <div className="l">медиана ответа 2ГИС</div>
          </div>
          <div className="stat">
            <div className="v">3</div>
            <div className="l">ретрая на отказ провайдера</div>
          </div>
          <div className="stat">
            <div className="v c-amber">2,1%</div>
            <div className="l">запросов упало до гаверсинуса</div>
          </div>
        </div>
      </div>
    </section>
  );
}

// === A5: Импорт ===
function A5ImportBlock() {
  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">A5</span>
        <span className="sec-title">Импорт данных</span>
        <span className="sec-sub">CSV / ZIP-архивы SensorLogger</span>
      </div>
      <div className="card">
        <div className="legacy-grid-2col">
          <div>
            <h4 style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 8, color: "var(--ink)" }}>
              <Upload className="h-3.5 w-3.5" style={{ display: "inline", marginRight: 6, verticalAlign: -2 }} />
              CSV-импорт
            </h4>
            <CsvImport />
          </div>
          <div>
            <h4 style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 8, color: "var(--ink)" }}>
              <Upload className="h-3.5 w-3.5" style={{ display: "inline", marginRight: 6, verticalAlign: -2 }} />
              ZIP-импорт
            </h4>
            <ZipImport />
          </div>
        </div>
      </div>
    </section>
  );
}

// === A6: Канал загрузки (диагностика инжеста) ===
// Отвечает на вопрос «почему не подтягиваются новые поездки»:
// показывает свежесть последней сессии в БД, URL эндпоинта для SensorLogger
// и позволяет прямо из браузера проверить доступность сервера и валидность
// INGEST_TOKEN (тест-push с пустым батчем — данных не создаёт).
function A6IngestDiagBlock() {
  // v2.11.0 (U-2): limit 50 — общий кэш-ключ с layout/app-root/trips (ответ
  // из кэша при заходе на вкладку Админ); gate на isLoading: пока список
  // грузится, НЕ показываем красное «данных не приходили никогда».
  const sessions = useSessions({ limit: 50 });
  const list = sessions.data?.sessions ?? [];
  const latest = list.length
    ? Math.max(...list.map((s) => new Date(s.endTime ?? s.startTime).getTime()))
    : null;
  const hoursAgo = latest != null ? (Date.now() - latest) / 3_600_000 : null;

  // v2.11.0 (U-24): токен для сборки URL — живёт только в локальном стейте
  // (в БД/на сервер не отправляется), поле password-типа.
  const [urlToken, setUrlToken] = React.useState("");
  const [token, setToken] = React.useState("");
  const [testing, setTesting] = React.useState(false);
  const [result, setResult] = React.useState<{
    status: number;
    ms: number;
    body: unknown;
    withToken: boolean;
    networkError?: string;
  } | null>(null);

  async function runTest() {
    const withToken = token.trim().length > 0;
    setTesting(true);
    setResult(null);
    const t0 = performance.now();
    try {
      const url = `/api/ingest/sensorlogger?deviceId=diag-web${
        withToken ? `&token=${encodeURIComponent(token.trim())}` : ""
      }`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "[]",
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        /* не JSON — ок */
      }
      setResult({ status: res.status, ms: Math.round(performance.now() - t0), body, withToken });
    } catch (e) {
      setResult({
        status: 0,
        ms: Math.round(performance.now() - t0),
        body: null,
        withToken,
        networkError: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTesting(false);
    }
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  // U-24: с введённым токеном URL собирается «боевым» (токен подставляется),
  // без токена — шаблон с плейсхолдером <INGEST_TOKEN>.
  const urlTokenTrim = urlToken.trim();
  const endpointUrl = `${origin}/api/ingest/sensorlogger?token=${
    urlTokenTrim ? encodeURIComponent(urlTokenTrim) : "<INGEST_TOKEN>"
  }&deviceId=<ID>`;

  function copyUrl() {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(endpointUrl).then(
        () =>
          toast.success(
            urlTokenTrim ? "URL с токеном скопирован" : "URL для SensorLogger скопирован"
          ),
        () => toast.error("Не удалось скопировать")
      );
    }
  }

  // v2.11.0 (U-19): перекрёстная ссылка A6 → L1 — прокрутка к журналу попыток.
  function scrollToIngestDiag() {
    const el = document.getElementById("ingest-diag-l1");
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      toast.info("Блок L1 «Состояние системы» ниже на странице");
    }
  }

  // Интерпретация результата теста
  let verdict: { tone: "ok" | "warn" | "err"; title: string; text: string } | null =
    null;
  if (result) {
    if (result.status === 0) {
      verdict = {
        tone: "err",
        title: "Сервер недоступен",
        text: `Браузер не смог достучаться до эндпоинта: ${result.networkError ?? "сетевая ошибка"}. Проверьте соединение.`,
      };
    } else if (result.status === 401) {
      verdict = result.withToken
        ? {
            tone: "err",
            title: "Токен отклонён (401)",
            text: "Сервер доступен, но INGEST_TOKEN не совпадает с токеном на сервере (переменная INGEST_TOKEN в окружении). Обновите токен в настройках HTTP Push в SensorLogger — именно из-за этого поездки молча не доходят.",
          }
        : {
            tone: "ok",
            title: "Сервер доступен",
            text: "Эндпоинт отвечает (401 без токена — это норма: токен обязателен). Чтобы проверить сам токен, вставьте его в поле выше и повторите тест.",
          };
    } else if (result.status === 200) {
      verdict = {
        tone: "ok",
        title: "Канал и токен работают",
        text: "URL и INGEST_TOKEN верны — сервер принял тест-push. Если новые поездки всё равно не появляются, проблема в настройке SensorLogger на iPhone (см. чек-лист ниже): сервер от телефона данных не получает.",
      };
    } else {
      verdict = {
        tone: "warn",
        title: `Неожиданный ответ: HTTP ${result.status}`,
        text: "Сервер ответил неожиданным образом — смотрите тело ответа ниже.",
      };
    }
  }

  const toneClass =
    verdict?.tone === "ok"
      ? "diag-ok"
      : verdict?.tone === "err"
        ? "diag-err"
        : "diag-warn";

  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">A6</span>
        <span className="sec-title">Канал загрузки</span>
        <span className="sec-sub">SensorLogger → /api/ingest/sensorlogger</span>
      </div>
      <div className="card">
        {/* Свежесть данных */}
        <div className="diag-row">
          <Radio className="h-3.5 w-3.5" style={{ flexShrink: 0 }} />
          {/* v2.11.0 (U-2): серый «проверяем…» вместо красного «нет ни одной
              сессии» — пока запрос в полёте это не ошибка, а стейт загрузки. */}
          {sessions.isLoading ? (
            <span className="diag-last" style={{ color: "var(--faint)" }}>
              проверяем свежесть данных…
            </span>
          ) : sessions.isError ? (
            <span className="diag-last" style={{ color: "var(--amber)" }}>
              не удалось загрузить список сессий (сеть/401) — обновите страницу
            </span>
          ) : latest == null ? (
            <span className="diag-last" style={{ color: "var(--red)" }}>
              В базе нет ни одной сессии — данные не приходили никогда.
            </span>
          ) : (
            <span
              className="diag-last"
              style={{ color: hoursAgo! > 24 ? "var(--amber)" : "var(--plum)" }}
            >
              Последняя загрузка: {" "}
              <b>
                {new Date(latest).toLocaleString("ru-RU", {
                  day: "2-digit",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </b>{" "}
              ({formatAge(hoursAgo!)} назад)
              {hoursAgo! > 24
                ? " — новых данных с телефона не поступало."
                : " — канал живой."}
            </span>
          )}
        </div>

        {/* v2.11.0 (U-19): переход к журналу попыток приёма в L1 */}
        <button type="button" className="ingest-jump" onClick={scrollToIngestDiag}>
          журнал попыток приёма → L1
        </button>

        {/* URL для SensorLogger */}
        <div className="diag-url">
          <span className="diag-url-label">URL для SensorLogger (HTTP Push):</span>
          <div className="diag-url-row">
            <code className="mono">{endpointUrl}</code>
            <Button
              variant="outline"
              size="sm"
              onClick={copyUrl}
              className="diag-copy"
              aria-label="Собрать URL с токеном и скопировать"
            >
              <Copy className="h-3.5 w-3.5" />
              {urlTokenTrim ? "Собрать URL" : ""}
            </Button>
          </div>
          {/* v2.11.0 (U-24): поле для токена — password-тип, значение не
              отправляется на сервер, живёт только в этом браузере. */}
          <div className="diag-test-row" style={{ marginTop: 8 }}>
            <Input
              type="password"
              value={urlToken}
              onChange={(e) => setUrlToken(e.target.value)}
              placeholder="INGEST_TOKEN — подставить в URL вместо <INGEST_TOKEN>"
              className="mono diag-token"
              autoComplete="off"
              spellCheck={false}
              aria-label="INGEST_TOKEN для сборки URL"
            />
          </div>
          <span className="diag-url-hint">
            Токен задаётся в env сервера (см. OPERATIONS.md). Введите его в поле
            выше — URL и кнопка копирования автоматически соберут ссылку с
            токеном (значение остаётся только в этом браузере). Вместо &lt;ID&gt;
            подставьте любой идентификатор устройства, например iphone15pro.
          </span>
        </div>

        {/* Тест канала */}
        <div className="diag-test">
          <span className="diag-url-label">Проверка канала из браузера:</span>
          <div className="diag-test-row">
            <Input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="INGEST_TOKEN (необязательно)"
              className="mono diag-token"
              autoComplete="off"
              spellCheck={false}
            />
            <Button onClick={runTest} disabled={testing} className="diag-run">
              {testing ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              {testing ? "Проверяю…" : "Проверить"}
            </Button>
          </div>
          <span className="diag-url-hint">
            Без токена — проверка доступности сервера (ожидаем 401). С токеном —
            полная проверка: URL + токен (ожидаем «push test passed»). Тест
                ничего не записывает в базу.
          </span>

          {result ? (
            <div className={`diag-result ${toneClass}`} role="status">
              <div className="diag-result-head">
                <b>{verdict?.title}</b>
                <span className="mono">HTTP {result.status || "—"} · {result.ms} мс</span>
              </div>
              <p>{verdict?.text}</p>
              <details className="diag-raw">
                <summary>Тело ответа</summary>
                <pre className="mono">{JSON.stringify(result.body, null, 2)}</pre>
              </details>
            </div>
          ) : null}
        </div>

        {/* Чек-лист для телефона */}
        <details className="diag-checklist">
          <summary>
            Чек-лист: что проверить на iPhone, если поездки не доходят
          </summary>
          <ol>
            <li>
              В SensorLogger запущена сессия логирования с включённым{" "}
              <b>HTTP Push</b> (Log → сессия, где указан этот URL). Обычная
              запись без Push копит данные только в файлы на телефоне.
            </li>
            <li>
              <b>Background App Refresh</b> включён для SensorLogger:
              Настройки → Основные → Обновление контента.
            </li>
            <li>
              В настройках HTTP Push URL совпадает с показанным выше (домен,
              путь, токен, deviceId). Опечатка в токене = тихие 401.
            </li>
            <li>
              Кнопка <b>Test Push</b> в настройках SensorLogger возвращает
              «push test passed».
            </li>
            <li>
              Телефон не в VPN/фильтрующем Wi-Fi — попробуйте мобильный
              интернет и повторите запись.
            </li>
          </ol>
        </details>
      </div>
    </section>
  );
}

function formatAge(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} мин`;
  if (hours < 48) return `${Math.round(hours)} ч`;
  return `${Math.round(hours / 24)} дн`;
}

// === Legacy: Состояние системы ===
function SystemInfoLegacyCard() {
  const health = useHealth();
  // v2.11.0 (U-1): isLoading пробрасываем в диагностику канала приёма —
  // пока /api/stats в полёте, НЕ показываем красное «попыток не зафиксировано».
  const stats = useStats();

  const items = [
    {
      icon: <Activity className="h-3.5 w-3.5" />,
      label: "Статус системы",
      value: health.data?.status === "ok" ? "OK" : health.data?.status || "—",
      color: health.data?.status === "ok" ? "var(--plum)" : "var(--amber)",
    },
    {
      icon: <Cpu className="h-3.5 w-3.5" />,
      label: "БД",
      value: health.data?.db === "ok" ? "OK" : health.data?.db || "—",
      color: health.data?.db === "ok" ? "var(--plum)" : "var(--amber)",
    },
    {
      icon: <Server className="h-3.5 w-3.5" />,
      label: "Worker",
      value: health.data?.worker === "ok" ? "OK" : health.data?.worker || "—",
      color: health.data?.worker === "ok" ? "var(--plum)" : "var(--amber)",
    },
    {
      icon: <Activity className="h-3.5 w-3.5" />,
      label: "Uptime",
      value: health.data ? `${Math.round(health.data.uptime / 60)} мин` : "—",
    },
    {
      icon: <Database className="h-3.5 w-3.5" />,
      label: "Сессий (всего)",
      value: stats.data ? fmtNumber(stats.data.totalSessions) : "—",
    },
    {
      icon: <HardDrive className="h-3.5 w-3.5" />,
      label: "GPS-точек (всего)",
      value: stats.data ? fmtNumber(stats.data.totalPoints) : "—",
    },
    {
      icon: <Hash className="h-3.5 w-3.5" />,
      label: "TrafficJob dead",
      value: stats.data ? String(stats.data.deadJobs) : "—",
      color: (stats.data?.deadJobs ?? 0) > 0 ? "var(--red)" : undefined,
    },
    {
      icon: <Zap className="h-3.5 w-3.5" />,
      label: "Rate limit (ingest)",
      value: stats.data ? `${stats.data.capacity.rateLimitMaxIngest}/мин` : "—",
    },
    {
      icon: <Zap className="h-3.5 w-3.5" />,
      label: "Target load",
      value: stats.data ? `${stats.data.capacity.targetLoadRpm} сесс/мин` : "—",
    },
  ];

  return (
    <div className="legacy-card">
      <h3>
        <span className="num">L1</span>
        <Server className="h-4 w-4" style={{ color: "var(--plum)" }} />
        Состояние системы
      </h3>
      <div className="desc">Live-данные с /api/health и /api/stats. Обновляется автоматически.</div>
      {/* v2.11.0 (U-7): честный баннер при недоступности live-данных (сеть/401),
          пока «—»-плейсхолдеры в сетке ниже */}
      {(health.isError || stats.isError) && (
        <div
          className="ingest-hint"
          role="alert"
          style={{
            background: "var(--amber-dim)",
            borderLeft: "3px solid var(--amber)",
            borderRadius: 4,
            padding: "8px 10px",
            color: "var(--amber-text)",
          }}
        >
          live-данные недоступны (сеть/401) — обновите страницу
        </div>
      )}
      <div className="stats-grid" style={{ marginTop: 0 }}>
        {items.map((it, i) => (
          <div className="stat" key={i}>
            <div className="v" style={{ color: it.color }}>
              {it.value}
            </div>
            <div className="l">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                {it.icon}
                {it.label}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* DIAG-1 (v2.10.6): диагностика канала приёма. «Тихие» исходы инжеста
          (пустой батч / без GPS / точки отброшены по accuracy / 401 / 400)
          раньше не оставляли следов в БД — приложение показывало «отправлено
          успешно», а поездок не было. Теперь каждая авторизованная попытка
          фиксируется в Setting «diag.ingest.trace» и видна здесь. */}
      <IngestChannelDiag
        trace={stats.data?.ingestTrace ?? null}
        isLoading={stats.isLoading}
        isError={stats.isError}
      />
    </div>
  );
}

// === DIAG-1: диагностика канала приёма данных (ингест) ===
function IngestChannelDiag({
  trace,
  isLoading,
  isError,
}: {
  trace: NonNullable<StatsResponse["ingestTrace"]> | null;
  // v2.11.0 (U-1): true, пока /api/stats ещё в полёте — нейтральный серый статус
  // вместо ложного красного «попыток не зафиксировано».
  isLoading?: boolean;
  // v2.11.0 (U-7): true при ошибке /api/stats — янтарный статус вместо красного.
  isError?: boolean;
}) {
  const last = trace?.last ?? null;
  const recent = trace?.recent ?? [];

  // v2.10.8: полный дамп последнего нераспознанного батча — ленивая загрузка
  // по кнопке (/api/stats?ingestRaw=1): до 64 КБ, не тянем в каждом запросе.
  // v2.11.0 (U-3): ошибки загрузки больше не маскируются под «нераспознанных
  // батчей не сохранилось» — различаем ошибку и честное «дампа нет».
  const [raw, setRaw] = React.useState<StatsResponse["ingestRaw"] | null>(null);
  const [rawLoading, setRawLoading] = React.useState(false);
  const [rawOpen, setRawOpen] = React.useState(false);
  const [rawError, setRawError] = React.useState<string | null>(null);
  const loadRaw = React.useCallback(async () => {
    setRawLoading(true);
    setRawError(null);
    try {
      const res = await fetch("/api/stats?ingestRaw=1");
      if (res.ok) {
        const data = (await res.json()) as StatsResponse;
        setRaw(data.ingestRaw ?? null);
      } else {
        // 401 — сессия истекла; прочие коды — сервер/сеть
        setRawError(
          res.status === 401
            ? "не удалось загрузить дамп (HTTP 401) — повторите вход"
            : `не удалось загрузить дамп (HTTP ${res.status}) — повторите позже`
        );
      }
    } catch (e) {
      setRawError(
        `не удалось загрузить дамп (${e instanceof Error ? e.message : "сеть"}) — проверьте соединение`
      );
    } finally {
      setRawLoading(false);
    }
  }, []);
  const toggleRaw = React.useCallback(async () => {
    if (rawOpen) {
      setRawOpen(false);
      return;
    }
    setRawOpen(true);
    if (raw === null && !rawLoading) {
      await loadRaw();
    }
  }, [rawOpen, raw, rawLoading, loadRaw]);

  const lastAt = last ? new Date(last.at) : null;
  const lastTime = lastAt
    ? lastAt.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";
  const lastDay = lastAt ? lastAt.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }) : "";

  const statusColor =
    isLoading && !trace
      ? "var(--faint)" // U-1: стейт загрузки — нейтральный серый
      : isError && !trace
        ? "var(--amber)" // U-7: нет ответа /api/stats — статус неизвестен
        : !last
          ? "var(--red)" // попыток не было вовсе — канал молчит (данные уже пришли)
          : last.outcome === "accepted"
            ? "var(--plum)"
            : "var(--amber)";
  const statusText =
    isLoading && !trace
      ? "проверяем последние попытки приёма…"
      : isError && !trace
        ? "журнал попыток недоступен (сеть/401)"
        : !last
          ? "попыток приёма не зафиксировано"
          : last.outcome === "accepted"
            ? `${lastDay} ${lastTime} · ${last.deviceId ?? "?"} · принято ${fmtNumber(last.points)} т.`
            : `${lastDay} ${lastTime} · ${last.deviceId ?? "?"} · ${INGEST_OUTCOME_RU[last.outcome] ?? last.outcome}`;

  const hint =
    isLoading && !trace
      ? "Загружаем журнал попыток приёма из /api/stats…"
      : isError && !trace
        ? "Не удалось прочитать журнал попыток (сеть/401) — обновите страницу"
        : !last
          ? "Ни один запрос инжеста не дошёл до сервера с момента включения диагностики: проверьте URL и токен в приложении"
          : last.outcome === "accepted"
            ? "Канал работает: точки дошли до БД"
            : last.outcome === "no_gps"
              ? "Запрос дошёл, но координаты не извлечены — ниже гистограмма сенсоров батча: если строки «location» в ней нет, GPS/Location не включён в списке сенсоров приложения"
              : last.outcome === "dropped_all"
                ? "Запрос дошёл, но все точки отброшены фильтром точности > 100 м (слабый GPS-сигнал)"
                : last.outcome === "empty"
                  ? "Пришёл пустой батч — это «Test Push», данных нет"
                  : last.outcome === "invalid"
                    ? "Формат тела запроса не прошёл валидацию (400)"
                    : "Повторная отправка уже известной сессии";

  // v2.10.7: образец структуры последнего нераспознанного батча — показывает,
  // под какими ключами приложение кладёт данные (кейс 01.09: 5 батчей × 28 КБ no_gps)
  const lastSample =
    recent.find((r) => r.sample && r.outcome !== "accepted")?.sample ??
    (last?.outcome !== "accepted" ? (last?.sample ?? null) : null);

  return (
    <div className="ingest-diag" id="ingest-diag-l1">
      <div className="param" style={{ borderBottom: "none" }}>
        <span>
          Канал приёма (инжест)
          <small>каждая попытка фиксируется в БД · переживает рестарты</small>
        </span>
        <b style={{ color: statusColor }}>{statusText}</b>
      </div>
      <div className="ingest-hint">{hint}</div>
      {lastSample && (
        <div className="ingest-sample-wrap">
          <div className="doc-log-cap">образец структуры последнего нераспознанного батча</div>
          <pre className="ingest-sample">{lastSample}</pre>
          {/* v2.10.8: полный дамп того же батча (до 64 КБ) — для точечного расширения парсера */}
          <button type="button" className="ingest-raw-btn" onClick={toggleRaw} disabled={rawLoading}>
            {rawLoading ? "загрузка…" : rawOpen ? "скрыть полный дамп" : "показать полный дамп батча"}
          </button>
          {rawOpen && !rawLoading && (
            rawError ? (
              <div
                className="ingest-hint"
                role="alert"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                  background: "var(--amber-dim)",
                  borderLeft: "3px solid var(--amber)",
                  borderRadius: 4,
                  padding: "7px 10px",
                  color: "var(--amber-text)",
                }}
              >
                <span>{rawError}</span>
                <button
                  type="button"
                  className="ingest-raw-btn"
                  style={{ marginTop: 0 }}
                  onClick={loadRaw}
                  disabled={rawLoading}
                >
                  повторить
                </button>
              </div>
            ) : raw ? (
              <pre className="ingest-sample ingest-raw">
                {`${new Date(raw.at).toLocaleString("ru-RU")} · ${raw.deviceId ?? "—"} · ${raw.outcome} · ${fmtNumber(raw.bytes)} Б${raw.truncated ? " · дамп обрезан до 64 КБ" : ""}\n\n${raw.body}`}
              </pre>
            ) : (
              <div className="ingest-hint">
                нераспознанных батчей не сохранилось — последний батч был распознан парсером
              </div>
            )
          )}
        </div>
      )}
      {recent.length > 1 && (
        <div className="ingest-list-wrap">
          {/* v2.11.0 (U-4): буфер — кольцо на 20 записей (MAX_RECENT), счётчик
              recent.length вводил в заблуждение «всего зафиксировано N». */}
          <div className="doc-log-cap">последние попытки · журнал хранит 20</div>
          <ul className="ingest-list">
            {recent.slice(0, 8).map((r, i) => {
              const t = new Date(r.at);
              const color = r.outcome === "accepted" ? "var(--plum)" : "var(--amber)";
              return (
                <li key={i}>
                  <span className="mono">
                    {t.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })}{" "}
                    {t.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                  <span>{r.route === "sensorlogger" ? "SensorLogger" : "API"}</span>
                  <span>{r.deviceId ?? "—"}</span>
                  <span style={{ color }}>{INGEST_OUTCOME_RU[r.outcome] ?? r.outcome}</span>
                  <span className="mono">
                    {r.outcome === "accepted" ? `${fmtNumber(r.points)} т.` : r.dropped > 0 ? `−${fmtNumber(r.dropped)} т.` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// === Legacy: Настройки маршрутизации ===
function RoutingSettingsLegacyCard() {
  const { data, isLoading, isFetching, refetch } = useSettings();
  const updateMut = useUpdateSetting();
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [dirty, setDirty] = React.useState<Record<string, boolean>>({});
  const [reveal, setReveal] = React.useState<Record<string, boolean>>({});

  const settings = data?.settings || [];

  React.useEffect(() => {
    if (settings.length > 0 && Object.keys(drafts).length === 0) {
      const init: Record<string, string> = {};
      for (const s of settings) init[s.key] = s.value;
      setDrafts(init);
    }
  }, [settings, drafts]);

  async function handleSave(key: string) {
    const value = drafts[key];
    if (value === undefined) return;
    // AUDIT B-14: сервер отдаёт секреты маской «****xx» — сохраняем только
    // реально изменённые пользователем значения, иначе перезапишем секрет маской.
    if (!dirty[key]) {
      toast.info("Значение не изменено");
      return;
    }
    try {
      await updateMut.mutateAsync({ key, value });
      setDirty((d) => ({ ...d, [key]: false }));
      toast.success(`Настройка обновлена: ${key}`);
    } catch (e) {
      toast.error("Ошибка сохранения", { description: (e as Error).message });
    }
  }

  return (
    <div className="legacy-card">
      <h3>
        <span className="num">L2</span>
        <SettingsIcon className="h-4 w-4" style={{ color: "var(--plum)" }} />
        Настройки маршрутизации
      </h3>
      <div className="desc">
        Переопределяемые параметры 2ГИС/OSRM. Сохраняются в БД (Setting). Изменения применяются без перезапуска.
      </div>
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full shimmer" />
          ))}
        </div>
      ) : settings.length === 0 ? (
        <div className="text-center py-6 text-sm" style={{ color: "var(--muted)" }}>
          <SettingsIcon className="h-8 w-8 mx-auto mb-2 opacity-30" />
          Нет переопределяемых настроек
        </div>
      ) : (
        <div className="space-y-2">
          {settings.map((s) => (
            <div key={s.key} className="space-y-1">
              <Label htmlFor={s.key} className="text-xs flex items-center gap-2" style={{ color: "var(--muted)" }}>
                <code style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--plum)" }}>{s.key}</code>
                <span className="text-[10px]" style={{ color: "var(--faint)" }}>
                  — источник: {s.source}{s.isSensitive ? " · секрет" : ""}
                </span>
              </Label>
              <div className="flex gap-2">
                <Input
                  id={s.key}
                  type={s.isSensitive && !reveal[s.key] ? "password" : "text"}
                  // AUDIT B-14: секрет показываем плейсхолдером-маской; реальное
                  // значение вводится заново только при изменении.
                  value={dirty[s.key] ? drafts[s.key] ?? "" : s.isSensitive ? "" : drafts[s.key] ?? ""}
                  placeholder={s.isSensitive && !dirty[s.key] ? s.value || "не задан" : ""}
                  onChange={(e) => {
                    setDrafts({ ...drafts, [s.key]: e.target.value });
                    setDirty({ ...dirty, [s.key]: true });
                  }}
                  className="font-mono text-xs h-8"
                  style={{ background: "var(--wash)", borderColor: "var(--line)", color: "var(--text)" }}
                />
                {s.isSensitive && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setReveal({ ...reveal, [s.key]: !reveal[s.key] })}
                    className="h-8 w-8 p-0"
                    title={reveal[s.key] ? "Скрыть секрет" : "Показать секрет"}
                    aria-label={reveal[s.key] ? "Скрыть секрет" : "Показать секрет"}
                  >
                    {reveal[s.key] ? "−" : "+"}
                  </Button>
                )}
                {/* v2.11.0 (U-21): видимая подпись «Сохранить» + aria-label —
                    иконочная кнопка была нечитаема для скринридеров */}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleSave(s.key)}
                  disabled={updateMut.isPending || !dirty[s.key]}
                  className="h-8 gap-1"
                  aria-label="Сохранить настройку"
                >
                  <ShieldCheck className="h-3.5 w-3.5" style={{ color: "var(--plum)" }} />
                  Сохранить
                </Button>
              </div>
              {s.updatedAt && (
                <p className="text-[10px]" style={{ color: "var(--faint)" }}>
                  Обновлено: {fmtDate(s.updatedAt)}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => refetch()}
          disabled={isFetching}
          className="gap-1.5"
        >
          {isFetching ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Обновить
        </Button>
      </div>
    </div>
  );
}

// === Legacy: Резервные копии ===
// v2.11.0 (U-16): общий хелпер кулдауна 1/час для кнопок создания бэкапов —
// после успешного создания кнопка блокируется с обратным отсчётом до
// освобождения слота (rate-limit admin:heavy POST = 1/час, 429 раньше
// приходил сюрпризом при повторном клике).
const BACKUP_RATE_LIMIT_MS = 60 * 60 * 1000;

function useBackupCooldown(createdListMs: number | null, localCreatedMs: number | null) {
  const [now, setNow] = React.useState(() => Date.now());
  const baseMs = Math.max(createdListMs ?? 0, localCreatedMs ?? 0);
  const leftMs = baseMs > 0 ? BACKUP_RATE_LIMIT_MS - (now - baseMs) : 0;
  const active = leftMs > 0;
  React.useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [active]);
  return {
    active,
    minutesLeft: Math.max(1, Math.ceil(leftMs / 60_000)),
  };
}

function newestCreatedAtMs(list: Array<{ createdAt: string }>): number | null {
  let acc: number | null = null;
  for (const b of list) {
    const t = Date.parse(b.createdAt);
    if (Number.isFinite(t) && (acc == null || t > acc)) acc = t;
  }
  return acc;
}

function BackupsLegacyCard() {
  const { data, isLoading, isFetching, refetch } = useBackups();
  const createMut = useCreateBackup();
  const [localCreatedMs, setLocalCreatedMs] = React.useState<number | null>(null);

  async function handleCreate() {
    try {
      const res = await createMut.mutateAsync();
      setLocalCreatedMs(Date.now());
      toast.success("Backup создан", {
        description: `${res.backupId.slice(0, 12)}… · ${res.fileSize ? fmtBytes(res.fileSize) : "—"}`,
      });
    } catch (e) {
      toast.error("Ошибка backup", { description: (e as Error).message });
    }
  }

  const backups = data?.backups || [];
  const cooldown = useBackupCooldown(newestCreatedAtMs(backups), localCreatedMs);

  return (
    <div className="legacy-card">
      <h3>
        <span className="num">L3</span>
        <Database className="h-4 w-4" style={{ color: "var(--plum)" }} />
        Резервные копии
      </h3>
      <div className="desc">Логический дамп БД. Лимит 1/час (rate-limit на ADMIN_TOKEN).</div>
      <div className="space-y-3">
        <Button
          onClick={handleCreate}
          disabled={createMut.isPending || cooldown.active}
          className="w-full"
          style={{ background: "var(--plum)", color: "var(--fg-on-dark)" }}
          variant="default"
          title={cooldown.active ? "Создание бэкапа доступно раз в час" : undefined}
        >
          {createMut.isPending ? (
            <>
              <RefreshCw className="h-4 w-4 animate-spin" /> Создание дампа…
            </>
          ) : cooldown.active ? (
            <>лимит 1/час — доступно через {cooldown.minutesLeft} мин</>
          ) : (
            <>
              <Database className="h-4 w-4" /> Создать backup
            </>
          )}
        </Button>

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : backups.length === 0 ? (
          <div className="text-center py-6 text-sm" style={{ color: "var(--muted)" }}>
            <Database className="h-8 w-8 mx-auto mb-2 opacity-30" />
            Пока нет backup'ов
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto scroll-telem -mx-2">
            <ul className="space-y-1.5 px-2">
              <AnimatePresence>
                {backups.map((b) => (
                  <motion.li
                    key={b.id}
                    layout
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: -8 }}
                    className="rounded-lg border p-2.5 text-xs space-y-1"
                    style={{ borderColor: "var(--line)", background: "var(--wash)" }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] truncate" style={{ color: "var(--muted)" }}>
                        {b.id}
                      </span>
                      <span
                        className={cn("text-[10px] px-2 py-0.5 rounded", b.status === "completed" ? "c-plum" : b.status === "failed" ? "c-red" : "c-amber")}
                        style={{
                          background: b.status === "completed" ? "var(--plum-dim)" : b.status === "failed" ? "var(--red-dim)" : "var(--amber-dim)",
                        }}
                      >
                        {b.status === "completed" ? <CheckCircle2 className="h-2.5 w-2.5 inline mr-1" /> : b.status === "failed" ? <AlertCircle className="h-2.5 w-2.5 inline mr-1" /> : null}
                        {/* v2.11.0 (U-15): RU-подпись статуса вместо сырого enum */}
                        {BACKUP_STATUS_RU[b.status] ?? b.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] flex-wrap" style={{ color: "var(--muted)" }}>
                      <span className="inline-flex items-center gap-1">
                        <HardDrive className="h-3 w-3" />
                        {b.fileSize ? fmtBytes(b.fileSize) : "—"}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Hash className="h-3 w-3" />
                        {b.checksum ? b.checksum.slice(0, 12) : "—"}
                      </span>
                      <span>{fmtDate(b.createdAt)}</span>
                    </div>
                    {b.error && (
                      <div className="text-[10px] font-mono c-red">{b.error}</div>
                    )}
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          </div>
        )}
      </div>
      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isFetching} className="gap-1.5">
          {isFetching ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Обновить
        </Button>
      </div>
    </div>
  );
}

// === Legacy: GitHub Backup ===
function GitHubBackupLegacyCard() {
  const { data, isLoading, isFetching, refetch } = useGitHubBackups();
  const createMut = useCreateGitHubBackup();
  const [localCreatedMs, setLocalCreatedMs] = React.useState<number | null>(null);

  async function handleCreate() {
    try {
      const res = await createMut.mutateAsync();
      setLocalCreatedMs(Date.now());
      toast.success("Backup загружен на GitHub", {
        description: `${res.backupId.slice(0, 12)}… · ${fmtBytes(res.assetSize)}`,
      });
    } catch (e) {
      toast.error("Ошибка GitHub backup", { description: (e as Error).message });
    }
  }

  const configured = data?.configured !== false;
  const backups = data?.backups || [];
  const cooldown = useBackupCooldown(newestCreatedAtMs(backups), localCreatedMs);

  return (
    <div className="legacy-card">
      <h3>
        <span className="num">L4</span>
        <Github className="h-4 w-4" style={{ color: "var(--plum)" }} />
        GitHub Backup
      </h3>
      <div className="desc">Резервные копии в GitHub Releases (приватные draft-релизы — только владелец репо).</div>
      {!configured ? (
        <div
          className="rounded-lg p-3 text-xs flex items-start gap-2"
          style={{ background: "var(--amber-dim)", border: "1px solid var(--amber)", color: "var(--amber)" }}
        >
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">GITHUB_TOKEN не настроен</div>
            <p className="mt-0.5 opacity-80">
              Установите <code style={{ fontFamily: "var(--mono)" }}>GITHUB_TOKEN</code> и{" "}
              <code style={{ fontFamily: "var(--mono)" }}>GITHUB_REPO</code>.
            </p>
          </div>
        </div>
      ) : (
        <>
          <Button
            onClick={handleCreate}
            disabled={createMut.isPending || cooldown.active}
            className="w-full gap-1.5"
            style={{ background: "var(--plum)", color: "var(--fg-on-dark)" }}
            variant="default"
            title={cooldown.active ? "Создание бэкапа доступно раз в час" : undefined}
          >
            {createMut.isPending ? (
              <>
                <RefreshCw className="h-4 w-4 animate-spin" /> Загрузка на GitHub…
              </>
            ) : cooldown.active ? (
              <>лимит 1/час — доступно через {cooldown.minutesLeft} мин</>
            ) : (
              <>
                <Github className="h-4 w-4" /> Создать backup на GitHub
              </>
            )}
          </Button>
          {isLoading ? (
            <div className="space-y-2 mt-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : backups.length === 0 ? (
            <div className="text-center py-6 text-sm mt-3" style={{ color: "var(--muted)" }}>
              <Github className="h-8 w-8 mx-auto mb-2 opacity-30" />
              Пока нет GitHub backup'ов
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto scroll-telem mt-3 -mx-2">
              <ul className="space-y-1.5 px-2">
                {backups.map((b) => (
                  <li
                    key={b.backupId}
                    className="rounded-lg border p-2.5 text-xs space-y-1"
                    style={{ borderColor: "var(--line)", background: "var(--wash)" }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] truncate" style={{ color: "var(--muted)" }}>
                        {b.tagName || b.backupId.slice(0, 12)}
                      </span>
                      <span
                        className="text-[10px] px-2 py-0.5 rounded"
                        style={{
                          background: b.isDraft ? "var(--amber-dim)" : "var(--plum-dim)",
                          color: "var(--amber-text, var(--amber))",
                        }}
                      >
                        <CheckCircle2 className="h-2.5 w-2.5 inline mr-1" />
                        {/* v2.11.0 (C-1): draft-бэкапы приватные, честная подпись */}
                        {b.isDraft ? "приватный" : "релиз"}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] flex-wrap" style={{ color: "var(--muted)" }}>
                      <span className="inline-flex items-center gap-1">
                        <HardDrive className="h-3 w-3" />
                        {fmtBytes(b.assetSize)}
                      </span>
                      {b.checksum && (
                        <span className="inline-flex items-center gap-1">
                          <Hash className="h-3 w-3" />
                          {b.checksum.slice(0, 12)}
                        </span>
                      )}
                      <span>{fmtDate(b.createdAt)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isFetching} className="gap-1.5">
          {isFetching ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Обновить
        </Button>
      </div>
    </div>
  );
}

// === Legacy: Requeue TrafficJob ===
function RequeueLegacyCard() {
  const [jobId, setJobId] = React.useState("");
  const requeueMut = useRequeueJob();

  async function handleRequeue() {
    if (!jobId.trim()) {
      toast.error("Введите Job ID");
      return;
    }
    try {
      const res = await requeueMut.mutateAsync(jobId.trim());
      toast.success("Задача перезапущена", {
        description: `${res.jobId.slice(0, 12)}… → ${res.status}`,
      });
      setJobId("");
    } catch (e) {
      toast.error("Ошибка requeue", { description: (e as Error).message });
    }
  }

  return (
    <div className="legacy-card">
      <h3>
        <span className="num">L5</span>
        <RotateCcw className="h-4 w-4" style={{ color: "var(--plum)" }} />
        Requeue TrafficJob
      </h3>
      <div className="desc">Перезапуск «мёртвых» (dead/failed) задач получения пробок.</div>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="job-id" className="text-xs" style={{ color: "var(--muted)" }}>
            Job ID
          </Label>
          <Input
            id="job-id"
            value={jobId}
            onChange={(e) => setJobId(e.target.value)}
            placeholder="cmt73676l0000rhh6nqzgjpab"
            className="font-mono text-xs"
            style={{ background: "var(--wash)", borderColor: "var(--line)", color: "var(--text)" }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRequeue();
            }}
          />
        </div>
        <Button
          onClick={handleRequeue}
          disabled={requeueMut.isPending || !jobId.trim()}
          className="w-full"
          variant="default"
          style={{ background: "var(--plum)", color: "var(--fg-on-dark)" }}
        >
          {requeueMut.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
          Перезапустить
        </Button>
        <div
          className="rounded-lg p-3 text-xs space-y-1"
          style={{ background: "var(--wash)", border: "1px solid var(--line)" }}
        >
          <div className="flex items-center gap-1.5 font-medium" style={{ color: "var(--plum)" }}>
            <ShieldCheck className="h-3.5 w-3.5" />
            Защита
          </div>
          <p style={{ color: "var(--muted)" }}>
            Requeue доступен только для задач в статусе <code style={{ fontFamily: "var(--mono)" }}>dead</code> или{" "}
            <code style={{ fontFamily: "var(--mono)" }}>failed</code>. Атомарное обнуление attempts и lockedBy. Лимит 10/мин.
          </p>
        </div>
      </div>
    </div>
  );
}
