# Методология и метрики — «Телеметрия поездок»

> **Сервис:** Телеметрия поездок v2.10.4 · **Версия документа:** 2.10.4 · **Дата:** 2026-08-31
> **Объём:** 23 раздела · 62 метрики в 8 группах + служебный идентификатор routeId · формулы, пороги, псевдокод, примеры
> Формат: Markdown (единый файл для методолога и программиста)
> **Изменения v2.9 → v2.10.4:** §4.2 Дистанция и §4.3 AvgSpeed — активная часть (§4.11), полная дистанция записи отдаётся как `rawDistanceM`; §6.2/§6.3 — фактическое время план-факта = `ActiveDuration`; §6.5 — публичная share-страница считает KPI серверно по этой методологии; UI — разрывы в минутах/секундах, точность AvgSpeed в API 0,001 м/с.

## Содержание

- [1. Введение](#1-введение)
- [2. Принципы методологии](#2-принципы-методологии)
- [3. Источники данных](#3-источники-данных)
  - [3.1. GPS-точки от Sensor Logger](#31-gps-точки-от-sensor-logger)
  - [3.2. Нормализация](#32-нормализация)
  - [3.3. Фильтрация невалидных точек](#33-фильтрация-невалидных-точек)
  - [3.4. Идемпотентность через clientId](#34-идемпотентность-через-clientid)
- [4. Группа 1. Базовые метрики (13 метрик)](#4-группа-1-базовые-метрики-13-метрик)
  - [4.1. Длительность записи (Duration)](#41-длительность-записи-duration)
  - [4.2. Дистанция (Distance)](#42-дистанция-distance)
  - [4.3. Средняя скорость (AvgSpeed)](#43-средняя-скорость-avgspeed)
  - [4.4. Максимальная скорость (MaxSpeed)](#44-максимальная-скорость-maxspeed)
  - [4.5. Рекорд скорости за всё время (MaxSpeedAllTime)](#45-рекорд-скорости-за-всё-время-maxspeedalltime)
  - [4.6. Время в движении (MovingTime)](#46-время-в-движении-movingtime)
  - [4.7. Время стоянок (IdleTime)](#47-время-стоянок-idletime)
  - [4.8. Количество точек (PointCount)](#48-количество-точек-pointcount)
  - [4.9. Время начала и окончания (StartTime / EndTime)](#49-время-начала-и-окончания-starttime--endtime)
  - [4.10. Координаты старта и финиша (StartCoord / EndCoord)](#410-координаты-старта-и-финиша-startcoord--endcoord)
  - [4.11. Границы активной поездки (ActiveTrip)](#411-границы-активной-поездки-activetrip)
- [5. Группа 2. Скоростной анализ (6 метрик)](#5-группа-2-скоростной-анализ-6-метрик)
  - [5.1. Медианная скорость (SpeedP50)](#51-медианная-скорость-speedp50)
  - [5.2. Разброс скорости (SpeedStdDev)](#52-разброс-скорости-speedstddev)
  - [5.3. Распределение скоростей (SpeedDistribution)](#53-распределение-скоростей-speeddistribution)
  - [5.4. Время в пробках (TimeInTraffic)](#54-время-в-пробках-timeintraffic)
  - [5.5. Время крейсерского хода (TimeAtCruise)](#55-время-крейсерского-хода-timeatcruise)
  - [5.6. Перепады скорости (SpeedVariation)](#56-перепады-скорости-speedvariation)
- [6. Группа 3. План-фактный анализ (8 метрик)](#6-группа-3-план-фактный-анализ-8-метрик)
  - [6.1. Плановое время (PlanDuration)](#61-плановое-время-planduration)
  - [6.2. Фактическое время (ActualDuration)](#62-фактическое-время-actualduration)
  - [6.3. Отклонение по времени (DurationDeviation)](#63-отклонение-по-времени-durationdeviation)
  - [6.4. Плановая дистанция (PlanDistance)](#64-плановая-дистанция-plandistance)
  - [6.5. Фактическая дистанция (ActualDistance)](#65-фактическая-дистанция-actualdistance)
  - [6.6. Отклонение по дистанции (DistanceDeviation)](#66-отклонение-по-дистанции-distancedeviation)
  - [6.7. Отклонение скорости по сегментам (SpeedDeviation)](#67-отклонение-скорости-по-сегментам-speeddeviation)
  - [6.8. Потери времени из-за пробок (TimeLostToTraffic)](#68-потери-времени-из-за-пробок-timelosttotraffic)
- [7. Группа 4. Поведенческие метрики вождения (10 метрик)](#7-группа-4-поведенческие-метрики-вождения-10-метрик)
  - [7.1. Резкие торможения (HarshBrakingCount)](#71-резкие-торможения-harshbrakingcount)
  - [7.2. Резкие разгоны (HarshAccelCount)](#72-резкие-разгоны-harshaccelcount)
  - [7.3. Оценка плавности вождения (EcoScore, CAP-методика)](#73-оценка-плавности-вождения-ecoscore-cap-методика)
  - [7.4. Интенсивность ускорений (AccelerationRMS)](#74-интенсивность-ускорений-accelerationrms)
  - [7.5. Резкость рывков (JerkRMS)](#75-резкость-рывков-jerkrms)
  - [7.6. Равномерность скорости (SpeedConsistencyIndex)](#76-равномерность-скорости-speedconsistencyindex)
  - [7.7. Прямолинейность маршрута (BearingConsistency)](#77-прямолинейность-маршрута-bearingconsistency)
  - [7.8. Развороты (UTurnCount)](#78-развороты-uturncount)
  - [7.9. Повороты (TurnCount)](#79-повороты-turncount)
  - [7.10. Резкие манёвры на высокой скорости (HighSpeedCornering)](#710-резкие-манёвры-на-высокой-скорости-highspeedcornering)
- [8. Группа 5. Географические метрики (6 метрик)](#8-группа-5-географические-метрики-6-метрик)
  - [8.1. Географический охват маршрута (BoundingBox)](#81-географический-охват-маршрута-boundingbox)
  - [8.2. Извилистость маршрута (RouteEfficiency)](#82-извилистость-маршрута-routeefficiency)
  - [8.3. Перепад высот (AltitudeRange)](#83-перепад-высот-altituderange)
  - [8.4. Набор высоты (AltitudeGain)](#84-набор-высоты-altitudegain)
  - [8.5. Доля городской зоны (UrbanRatio)](#85-доля-городской-зоны-urbanratio)
  - [8.6. Средняя точность GPS (AvgAccuracy)](#86-средняя-точность-gps-avgaccuracy)
- [9. Группа 6. Трафик-метрики (5 метрик)](#9-группа-6-трафик-метрики-5-метрик)
  - [9.1. Сегменты с данными о пробках (TrafficFetchedSegments)](#91-сегменты-с-данными-о-пробках-trafficfetchedsegments)
  - [9.2. Средняя скорость с учётом пробок (AvgTrafficSpeed)](#92-средняя-скорость-с-учётом-пробок-avgtrafficspeed)
  - [9.3. Индекс загруженности (TrafficSeverity)](#93-индекс-загруженности-trafficseverity)
  - [9.4. Перегруженные сегменты (CongestedSegments)](#94-перегруженные-сегменты-congestedsegments)
  - [9.5. Время в заторах (TimeInCongestion)](#95-время-в-заторах-timeincongestion)
- [10. Группа 7. Сравнительные метрики по маршруту (8 метрик + routeId)](#10-группа-7-сравнительные-метрики-по-маршруту-8-метрик--routeid)
  - [10.0. Идентификатор маршрута (routeId)](#100-идентификатор-маршрута-routeid)
  - [10.1. Среднее, лучшее и худшее время маршрута (RouteAvgDuration / RouteBestDuration / RouteWorstDuration)](#101-среднее-лучшее-и-худшее-время-маршрута-routeavgduration--routebestduration--routeworstduration)
  - [10.2. Стабильность времени маршрута (RouteDurationStdDev)](#102-стабильность-времени-маршрута-routedurationstddev)
  - [10.3. Зависимость от времени суток (RouteTrafficPattern)](#103-зависимость-от-времени-суток-routetrafficpattern)
  - [10.4. Зависимость от дня недели (RouteDayOfWeekPattern)](#104-зависимость-от-дня-недели-routedayofweekpattern)
  - [10.5. Тренд времени маршрута (RouteTrend, Theil-Sen)](#105-тренд-времени-маршрута-routetrend-theil-sen)
  - [10.6. Хронически пробочные участки (HotspotSegments)](#106-хронически-пробочные-участки-hotspotsegments)
- [11. Группа 8. Метрики качества данных (6 метрик)](#11-группа-8-метрики-качества-данных-6-метрик)
  - [11.1. Плотность точек (PointDensity)](#111-плотность-точек-pointdensity)
  - [11.2. Количество разрывов (GapCount)](#112-количество-разрывов-gapcount)
  - [11.3. Суммарная длительность разрывов (GapTotalDuration)](#113-суммарная-длительность-разрывов-gaptotalduration)
  - [11.4. Точность GPS P90 (AccuracyP90)](#114-точность-gps-p90-accuracyp90)
  - [11.5. Полнота записи (CompletenessScore)](#115-полнота-записи-completenessscore)
  - [11.6. Индекс доверия к записи (SessionReliability)](#116-индекс-доверия-к-записи-sessionreliability)
- [12. Логика расчёта на сервере](#12-логика-расчёта-на-сервере)
  - [12.1. Пайплайн](#121-пайплайн)
  - [12.2. Расчёт метрик: when и where](#122-расчёт-метрик-when-и-where)
- [13. Цепочка маршрутизации](#13-цепочка-маршрутизации)
  - [13.1. 2ГИС carrouting 6.0.0](#131-2гис-carrouting-600)
  - [13.2. OSRM Demo Server](#132-osrm-demo-server)
  - [13.3. Гаверсинус (40 км/ч)](#133-гаверсинус-40-кмч)
  - [13.4. Snap-to-grid кэш](#134-snap-to-grid-кэш)
- [14. Кэширование маршрутов](#14-кэширование-маршрутов)
- [15. Идемпотентность](#15-идемпотентность)
- [16. Агрегация и статистика](#16-агрегация-и-статистика)
  - [16.1. Функции агрегации](#161-функции-агрегации)
  - [16.2. Курсорная пагинация](#162-курсорная-пагинация)
  - [16.3. Downsample для визуализации](#163-downsample-для-визуализации)
- [17. План-фактный анализ: детали](#17-план-фактный-анализ-детали)
  - [17.1. Сегментация маршрута](#171-сегментация-маршрута)
  - [17.2. Соответствие точек сегментам (HMM map matching)](#172-соответствие-точек-сегментам-hmm-map-matching)
  - [17.3. Edge cases](#173-edge-cases)
- [18. Визуализация метрик](#18-визуализация-метрик)
- [19. Граничные случаи и обработка ошибок](#19-граничные-случаи-и-обработка-ошибок)
- [20. Точность и погрешности](#20-точность-и-погрешности)
- [21. Производительность расчётов](#21-производительность-расчётов)
- [22. Приёмка методики](#22-приёмка-методики)
- [23. Приложения](#23-приложения)
- [Приложение А. Полный каталог метрик (62 метрики + routeId)](#приложение-а-полный-каталог-метрик-62-метрики--routeid)
- [Приложение Б. Глоссарий](#приложение-б-глоссарий)
- [Приложение В. Список литературы](#приложение-в-список-литературы)
- [Приложение Г. Ограничения методологии (out of scope)](#приложение-г-ограничения-методологии-out-of-scope)

---
## 1. Введение

Настоящий документ является исчерпывающей методологией расчёта метрик, логики обработки данных и методик анализа системы «Телеметрия поездок» версии 2.9. Документ описывает все 62 метрики в 8 группах (плюс служебный идентификатор маршрута `routeId`) с математическими формулами, обоснованием порогов, псевдокодом и примерами. Документ предназначен одновременно для методолога (структура и обоснование метрик) и для программиста (формулы и псевдокод, готовые к реализации на TypeScript).

Целевая аудитория: разработчики, аналитики данных, QA-инженеры, исследователи телематики. Документ предполагает базовое понимание математики (статистика, геометрия), программирования (TypeScript) и GPS-телеметрии.

Документ дополняет техническое задание «Метрики и мобильный интерфейс» v1.0, фокусируясь на математической стороне: вывод формул, обоснование пороговых значений, обработка граничных случаев, оценка погрешностей.

Каждая метрика имеет русскоязычное название (используется в UI и в тексте документа) и англоязычный идентификатор (используется в коде, БД и API). Каталог всех метрик — в приложении А.

## 2. Принципы методологии

Методология построена на восьми принципах:

- **Математическая корректность** — все формулы основаны на классической статистике, геометрии и теории вероятностей. Гаверсинус для расстояний, Welford для дисперсии, Theil-Sen для устойчивой регрессии, HMM для map matching.

- **Обоснованность порогов** — каждый порог (гистерезис 5/2 км/ч для движения, 10 км/ч для пробок, 30 сек для разрывов) имеет физическое или статистическое обоснование, а не взят произвольно.

- **Идемпотентность расчётов** — при повторном вычислении метрики для тех же входных данных результат идентичен. Никаких случайных чисел без детерминированного seed, включая статистическое сэмплирование (bootstrap в RouteTrend использует PRNG с seed из входных данных, раздел 10.5).

- **Граничные случаи** — каждая метрика имеет явное поведение при отсутствии данных, одной точке, делении на ноль, NaN, Infinity.

- **Производительность** — линейная сложность O(n) для большинства метрик, O(n²) в худшем случае для Theil-Sen (с bootstrap-сэмплированием при больших n). Один проход по данным (one-pass) где возможно.

- **Прослеживаемость** — каждая метрика в UI соответствует записи в этом документе с формулой и псевдокодом. Никаких «чёрных ящиков».

- **Активная поездка** — аналитические метрики (AvgSpeed, SpeedDistribution, EcoScore, DurationDeviation и др.) считаются по активной части записи (от первого до последнего интервала в состоянии «движение»), а не по всей записи. Стояния в начале и конце записи (включил датчик, но не поехал; приехал, но не выключил) не искажают аналитику. Границы активной поездки вычисляются через state machine MovingTime (раздел 4.6).

- **Устойчивость к выбросам** — сравнительные метрики (RouteTrend, HotspotSegments) используют непараметрические оценки (медиана, перцентили) вместо среднего, чтобы одна аномальная поездка (снегопад, ДТП) не уводила агрегаты.

## 3. Источники данных

### 3.1. GPS-точки от Sensor Logger

Основной источник данных — приложение Sensor Logger на iPhone. Точки передаются через POST /api/ingest в формате JSON. Каждая точка содержит:

| **Поле**  | **Тип** | **Единица** | **Описание**                  |
|-----------|---------|-------------|-------------------------------|
| lat       | Float   | градусы     | Широта (−90..90)              |
| lon       | Float   | градусы     | Долгота (−180..180)           |
| speed     | Float?  | м/с         | Скорость (может быть null)    |
| altitude  | Float?  | м           | Высота над уровнем моря       |
| accuracy  | Float?  | м           | Точность GPS (радиус)         |
| timestamp | BigInt  | нс          | Unix-время в наносекундах     |
| bearing   | Float?  | градусы     | Направление движения (0..360) |

### 3.2. Нормализация

Timestamp приходит в наносекундах (Sensor Logger), хранится как BigInt. Для расчётов нормализуется в миллисекунды: ts_ms = Number(ts_ns) / 1_000_000. Для JSON-сериализации: Number(timestamp). Деление на ноль исключено — точки с timestamp=0 фильтруются.

### 3.3. Фильтрация невалидных точек

Sensor Logger использует специальные значения-маркеры для отсутствующих данных:

- lat = −1, lon = −1 — нет GPS-фикса. Фильтруются.

- accuracy = −1 — нет данных о точности. Метрика AvgAccuracy игнорирует такие точки.

- speed = null или speed < 0 — скорость не определена. Метрики скорости игнорируют.

- altitude = null — высота не определена. Метрики высоты игнорируют.

- Точки с deltaTime > 30 сек от предыдущей — разрыв записи (gap). Учитываются в GapCount (раздел 11.2) и GapTime (раздел 4.6). Единый порог разрыва по всему документу — 30 секунд (разделы 3.3, 4.6, 11.2, 17.2).

### 3.4. Идемпотентность через clientId

Каждый пакет ingest содержит clientId (UUID). Уникальный индекс @@unique([deviceId, clientId]) в Session предотвращает дубликаты. При повторной отправке того же пакета возвращается существующая сессия с duplicate: true. Это гарантирует: одна поездка = один расчёт метрик.

## 4. Группа 1. Базовые метрики (13 метрик)

### 4.1. Длительность записи (Duration)

**Формула:**

```
Duration = endTime − startTime (миллисекунды)   // вся запись
Duration_sec = Duration / 1000 (секунды)
```

Назначение: общее время записи от первой до последней GPS-точки. Включает «хвосты» — стоянки в начале и конце, если пользователь включил датчик до начала движения или выключил после окончания. Для аналитических метрик (AvgSpeed, SpeedDistribution, план-факт, сравнительные) следует использовать `ActiveDuration` (раздел 4.11) — он отсекает хвосты. `Duration` остаётся как метаданные записи (для отладки, для метрик качества — CompletenessScore, PointDensity). Единица: минуты (отображение), секунды (расчёты).

**Псевдокод:**

```
function duration(points) {
  if (points.length < 2) return 0;
  const start = Number(points[0].timestamp);
  const end = Number(points[points.length - 1].timestamp);
  return Math.max(0, end - start); // мс
}
```

**Граничные случаи:**

- 0 точек → Duration = 0.
- 1 точка → Duration = 0 (нет интервала).
- Все timestamp одинаковые → Duration = 0.
- endTime < startTime (clock skew) → Math.max(0, ...) возвращает 0.

**Пример:**

Точки: t1=1723680010000, t2=1723680013000, t3=1723680016000. Duration = 1723680016000 − 1723680010000 = 6000 мс = 6 сек. Отображается как «6 сек» (не «0 мин»).

### 4.2. Дистанция (Distance)

**Формула:**

```
Distance = Σ haversine(p[i-1], p[i]) для i=1..n-1 (метры)
```

Назначение: пройденный путь — сумма расстояний между последовательными точками по дуге большого круга (гаверсинус). Единица: метры (для расчётов), километры (для отображения).

> **v2.10.3 — Дистанция KPI считается по активной части (§4.11):** в сумму включаются только интервалы внутри `[ActiveStartTime, ActiveEndTime]`. Стоянки-«хвосты» записи (включил датчик, но не поехал; приехал, но не выключил) дают GPS-дрейф — перемещения меньше радиуса погрешности, — который при суммировании по всей записи «накручивал» фиктивные сотни метров дистанции. Полная дистанция записи отдаётся отдельно как `rawDistanceM` (диагностика: `rawDistanceM − Distance` = вклад дрейфа хвостов). Группы маршрутов (§10) и публичная share-страница используют тот же канон.

**Формула гаверсинуса:**

```
hav(θ) = sin²(θ/2) a = sin²(Δlat/2) + cos(lat1)·cos(lat2)·sin²(Δlon/2) c = 2·arcsin(√a) d = R·c где R = 6 371 000 м (средний радиус Земли)
```

**Псевдокод:**

```
const R = 6371000; function haversine(lat1, lon1, lat2, lon2) { const toRad = d => d * Math.PI / 180; const dLat = toRad(lat2 - lat1); const dLon = toRad(lon2 - lon1); const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2; return 2 * R * Math.asin(Math.sqrt(a)); } function distance(points) { let d = 0; for (let i = 1; i < points.length; i++) { d += haversine(points[i-1].lat, points[i-1].lon, points[i].lat, points[i].lon); } return d; // метры }
```

**Граничные случаи:**

- < 2 точек → 0.

- Все точки совпадают (lat=lon) → 0.

- Точки идут в обратном порядке → Distance считается по абсолютному пути, не по «чистому» смещению.

**Пример:**

Точки: (55.751, 37.617), (55.752, 37.618), (55.753, 37.619). haversine(p1,p2) ≈ 128 м, haversine(p2,p3) ≈ 127 м. Distance = 255 м = 0,255 км.

### 4.3. Средняя скорость (AvgSpeed)

**Формула:**

```
AvgSpeed = Distance / ActiveDuration (м/с)   // аналитическая — без хвостов
AvgSpeed_kmh = AvgSpeed × 3.6 (км/ч)
```

Назначение: средняя скорость за активную часть поездки. Единица: м/с (расчёт), км/ч (отображение).

> **Важно:** формула использует `ActiveDuration` (раздел 4.11), а не `Duration`. При расчёте по `Duration` стоянка в начале/конце записи занижала бы AvgSpeed: поездка 30 минут на 40 км/ч с хвостом 10 минут дала бы 30 км/ч вместо «честных» 40. `ActiveDuration` отсекает хвосты через state machine из раздела 4.6.
>
> **v2.10.3:** числитель — Дистанция активной части (см. §4.2), т.е. обе величины берутся из одного окна `[ActiveStartTime, ActiveEndTime]` и формула однородна. Ранее числитель считался по всей записи — гибрид «вся запись / активное время». Если `hasActiveTrip = false` → AvgSpeed = null (нет поездки — нет средней скорости).

**Граничные случаи:**

- ActiveDuration = 0 (нет движения) → null (деление на ноль).
- ActiveDuration = 0 и Distance = 0 (стоял всю запись) → null.
- Distance = 0 и ActiveDuration > 0 (двигался, но на месте — GPS-дрейф) → 0.

**Пример:**

Distance = 255 м, ActiveDuration = 6 сек. AvgSpeed = 255/6 = 42,5 м/с = 153 км/ч. (Это нереалистично для города — данные тестовые.)

### 4.4. Максимальная скорость (MaxSpeed)

**Формула:**

```
MaxSpeed = max(points.speed) для всех speed != null && speed >= 0 (м/с)
```

Назначение: пиковая скорость в поездке. Единица: м/с (расчёт), км/ч (отображение).

**Граничные случаи:**

- Нет точек со speed → null.

- Все speed = 0 → 0.

- speed < 0 (невалидные) → игнорируются.

### 4.5. Рекорд скорости за всё время (MaxSpeedAllTime)

**Формула:**

```
MaxSpeedAllTime = max(p.speed) для всех p во всех Session пользователя (м/с)
```

Назначение: максимальная скорость за всю историю измерений. Агрегат по всем сессиям. Реализуется через SELECT MAX(speed) FROM GpsPoint WHERE session.userId = ?.

### 4.6. Время в движении (MovingTime)

**Формула:**

```
Для каждой пары точек i (интервал между точками i−1 и i):
  dt[i]      = (t[i] − t[i−1]) / 1000                      // сек
  disp_speed = haversine(p[i−1], p[i]) / dt[i]             // м/с
  gps_speed  = p[i].speed                                  // м/с (если есть)

Разрыв (gap):
  dt > 30 сек → интервал целиком относится к GapTime, состояние не меняется

Cross-check (защита от GPS-дрейфа):
  if disp_speed < (p[i].accuracy ?? 0) / dt[i]:    effective_speed = 0   // дрейф на стоянке
  else if gps_speed != null и gps_speed >= 0:      effective_speed = min(gps_speed, disp_speed × 1.5)
  else                                             effective_speed = disp_speed

Сглаживание:
  smoothed_speed[i] = медиана по окну из трёх соседних не-gap интервалов
                      (ближайший предыдущий не-gap, текущий, ближайший следующий не-gap)

Гистерезис (двухпороговый, относительно подтверждённого состояния):
  MOVING_START = 5 км/ч   // выше → переход idle → moving
  MOVING_STOP  = 2 км/ч   // ниже → переход moving → idle
  между 2 и 5 км/ч состояние сохраняется

Debounce:
  MIN_STATE_DURATION = 5 сек
  переход подтверждён, только если новое состояние непрерывно длится ≥ 5 сек;
  неподтверждённый переход (сбит гистерезисом, разрывом или концом записи)
  не происходит — интервалы кандидата приписываются прежнему состоянию

Правило приписки (инвариант одинарного учёта):
  каждый интервал относится ровно к одному из трёх состояний —
  moving / idle / gap — и его dt начисляется ровно один раз

Итог:
  MovingTime = Σ dt для интервалов в состоянии "moving"
  IdleTime   = Σ dt для интервалов в состоянии "idle"
  GapTime    = Σ dt для интервалов-разрывов
  states[]   = массив состояний длиной points.length − 1 (idle | moving | gap)

  Контрольная сумма:  MovingTime + IdleTime + GapTime = Duration (с точностью до мс)
```

Назначение: время в движении без стоянок и без разрывов записи. Единица: секунды. Методика возвращает массив `states[]` длиной `points.length − 1` со значениями `idle | moving | gap`, который используется как в других метриках (раздел 4.11 ActiveTrip, 7.8 UTurnCount — для отсева стоянок, 11.6 SessionReliability — для детекции дрейфа), так и в UI (timeline «движение / стоянка / разрыв»).

**Обоснование порога 5/2 км/ч (гистерезис):**

Старт движения (5 км/ч) — строже, чем остановка (2 км/ч). Это предотвращает «мигание» состояния на границе порога: чтобы стать «движением», скорость должна явно превысить 5 км/ч; чтобы снова стать «стоянкой» — упасть ниже 2 км/ч. Между 2 и 5 км/ч состояние сохраняется. Однопороговая схема на пробках с микродвижениями систематически «мигает» между состояниями.

**Обоснование cross-check по displacement:**

GPS-дрейф на стоянке даёт «ползущие» координаты при `speed = 0`. Если `disp_speed < accuracy / dt` (перемещение меньше радиуса погрешности за интервал), классифицируем как стоянку — это шум, а не движение.

**Обоснование debounce 5 сек:**

Короткий всплеск скорости 2–3 сек (рывок на светофоре, GPS-выброс) не должен превращать интервал в «движение». Минимальное состояние 5 сек отсекает такие всплески: интервалы неподтверждённого кандидата остаются в прежнем состоянии.

**Обоснование порога разрыва 30 сек:**

Интервалы более 30 секунд — разрыв записи (потеря сигнала, приостановка приложения). Такие интервалы не входят ни в `MovingTime`, ни в `IdleTime` — они попадают в `GapTime`. Это сохраняет контрольную сумму `MovingTime + IdleTime + GapTime = Duration`.

**Псевдокод:**

```typescript
type MotionState = 'idle' | 'moving' | 'gap';
type ActiveState = 'idle' | 'moving';

interface MotionResult {
  movingTime: number;       // сек
  idleTime: number;         // сек
  gapTime: number;          // сек
  states: MotionState[];    // длина = points.length − 1 (UI timeline, ActiveTrip, SessionReliability)
}

const MOVING_START_KMH = 5;
const MOVING_STOP_KMH  = 2;
const MIN_STATE_DURATION_SEC = 5;
const GAP_THRESHOLD_SEC = 30;

function computeMovingTime(points: GpsPoint[]): MotionResult {
  if (points.length < 2) return { movingTime: 0, idleTime: 0, gapTime: 0, states: [] };

  // Шаг 1: effective_speed для каждого интервала
  const intervals: { dt: number; v: number; isGap: boolean }[] = [];
  for (let i = 1; i < points.length; i++) {
    const dt = (Number(points[i].timestamp) - Number(points[i - 1].timestamp)) / 1000;
    if (dt <= 0)                { intervals.push({ dt: 0, v: 0, isGap: false }); continue; }
    if (dt > GAP_THRESHOLD_SEC) { intervals.push({ dt, v: 0, isGap: true  }); continue; }

    const dispSpeed = haversine(points[i - 1], points[i]) / dt;
    const driftThreshold = (points[i].accuracy ?? 0) / dt;

    let v: number;
    if (dispSpeed < driftThreshold) {
      v = 0;                                                  // GPS-дрейф
    } else if (points[i].speed != null && points[i].speed! >= 0) {
      v = Math.min(points[i].speed!, dispSpeed * 1.5);        // cross-check
    } else {
      v = dispSpeed;
    }
    intervals.push({ dt, v, isGap: false });
  }

  // Шаг 2: медианное сглаживание по окну 3 (соседи — только не-gap интервалы)
  const n = intervals.length;
  const smoothed: number[] = intervals.map(it => it.v);
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 === 1
      ? s[(s.length - 1) / 2]
      : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  for (let i = 0; i < n; i++) {
    if (intervals[i].isGap) continue;
    const win: number[] = [intervals[i].v];
    for (let j = i - 1; j >= 0; j--) { if (!intervals[j].isGap) { win.push(intervals[j].v); break; } }
    for (let j = i + 1; j < n;  j++) { if (!intervals[j].isGap) { win.push(intervals[j].v); break; } }
    smoothed[i] = median(win);
  }

  // Шаг 3: state machine с гистерезисом и debounce.
  // Инвариант: dt каждого интервала начисляется ровно один раз —
  // либо сразу (устойчивое состояние), либо пакетом кандидата
  // (новому состоянию при подтверждении, прежнему — при отмене).
  let state: ActiveState = 'idle';
  let pending: { state: ActiveState; fromIdx: number; dur: number } | null = null;
  let movingTime = 0, idleTime = 0, gapTime = 0;
  const states: MotionState[] = [];

  const accrue = (st: ActiveState, dur: number) => {
    if (st === 'moving') movingTime += dur; else idleTime += dur;
  };

  for (let i = 0; i < n; i++) {
    const { dt, isGap } = intervals[i];

    if (isGap) {
      if (pending) { accrue(state, pending.dur); pending = null; }  // кандидат отменён разрывом
      gapTime += dt;
      states.push('gap');
      continue;
    }

    const vKmh = smoothed[i] * 3.6;
    const desired: ActiveState =
      (state === 'idle'   && vKmh > MOVING_START_KMH) ? 'moving' :
      (state === 'moving' && vKmh < MOVING_STOP_KMH)  ? 'idle'   : state;

    if (desired === state) {
      // скорость вернулась в диапазон текущего состояния — кандидат отменён
      if (pending) { accrue(state, pending.dur); pending = null; }
      accrue(state, dt);
      states.push(state);
      continue;
    }

    // желаем переход в desired
    if (pending && pending.state !== desired) {   // направление сменилось — перезапуск кандидата
      accrue(state, pending.dur);
      pending = null;
    }
    if (!pending) pending = { state: desired, fromIdx: i, dur: 0 };
    pending.dur += dt;
    states.push(state);                            // до подтверждения — прежнее состояние

    if (pending.dur >= MIN_STATE_DURATION_SEC) {   // переход подтверждён
      accrue(desired, pending.dur);                // интервалы кандидата — новому состоянию
      for (let j = pending.fromIdx; j <= i; j++) states[j] = desired;  // ретроактивно в states[]
      state = desired;
      pending = null;
    }
  }

  // Шаг 4: финальный сброс — незакрытый кандидат относится к текущему состоянию
  if (pending) accrue(state, pending.dur);

  return { movingTime, idleTime, gapTime, states };
}
```

**Граничные случаи:**

- 0 точек → все 0.
- 1 точка → все 0 (нет интервалов).
- Все `speed = null` → используется `disp_speed` (cross-check).
- GPS-дрейф на стоянке (точки «ползут» при `speed = 0`) → cross-check отсекает (`disp_speed < accuracy/dt → v = 0 → idle`).
- Краткий всплеск 2–3 сек на светофоре → debounce 5 сек: всплеск остаётся в `idle`, время не теряется и не удваивается.
- Разрыв > 30 сек → `GapTime`, состояние не меняется, `states[i] = 'gap'`.
- Clock skew (`dt < 0`) → `dt = 0`, интервал пропускается.
- `dt = 0` (дубликаты timestamp) → пропускается (начисляется 0 сек).

**Контрольная сумма (обязательная проверка в тестах):**

```
Duration = MovingTime + IdleTime + GapTime
```

Контрольная сумма выполняется по построению: каждый интервал начисляется ровно один раз (см. «Правило приписки» и инвариант в шаге 3 псевдокода).

### 4.7. Время стоянок (IdleTime)

**Формула:**

```
IdleTime = Σ dt для интервалов в состоянии "idle"  (секунды)
         = MotionResult.idleTime  (см. раздел 4.6)
```

Назначение: время стоянок **внутри записи** (пробки, светофоры, остановки). Единица: секунды.

> **Важно:** `IdleTime` считается **независимо** как сумма интервалов в состоянии `idle` из state machine (раздел 4.6). Разностная схема (`IdleTime = Duration − MovingTime`) не используется по двум причинам:
>
> 1. Разностный подход накапливает ошибки обеих метрик — любая неточность в `MovingTime` напрямую искажает `IdleTime`.
> 2. Разностная формула включает разрывы записи в `IdleTime`, что неверно: разрыв — не стоянка, это потеря данных (интервалы разрыва относятся к `GapTime`).
>
> Контрольная сумма: `MovingTime + IdleTime + GapTime = Duration`.

Стояния в начале и конце записи (хвосты) попадают в `IdleTime`, но **не входят в активную часть поездки**. Для метрик, характеризующих поведение во время поездки (светофоры, пробки), используйте `ActiveIdleTime = IdleTime − (preTripIdle + postTripIdle)` (см. раздел 4.11) — это стоянки внутри поездки, исключая хвосты.

**Граничные случаи:**

- 0 точек → IdleTime = 0.
- 1 точка → IdleTime = 0.
- Все интервалы > 30 сек (только разрывы) → IdleTime = 0, всё в `GapTime`.
- MovingTime > Duration (clock skew) → невозможно по построению (контрольная сумма гарантируется state machine).

### 4.8. Количество точек (PointCount)

**Формула:**

```
PointCount = count(GpsPoint WHERE sessionId = ?)
```

Назначение: плотность данных. Единица: штуки. Используется для оценки качества записи и в метриках PointDensity, CompletenessScore, EcoScore (минимальный порог достаточности данных).

### 4.9. Время начала и окончания (StartTime / EndTime)

**Формула:**

```
StartTime = points[0].timestamp          // первая точка записи
EndTime   = points[n-1].timestamp       // последняя точка записи

// Аналитические границы (для план-факта, сравнительных, поведенческих метрик):
ActiveStartTime = points[firstMovingIdx].timestamp      // первая точка в состоянии moving
ActiveEndTime   = points[lastMovingIdx + 1].timestamp   // последняя точка в состоянии moving
```

Назначение: временной диапазон записи и временной диапазон активной поездки. Берётся из GPS-точек (не из полей Session, которые могут быть пустыми). `StartTime/EndTime` — для отображения пользователю «когда была запись». `ActiveStartTime/ActiveEndTime` — для аналитики, агрегатов и сравнения с планом.

> **Важно:** если запись началась за 5 минут до поездки (стоял во дворе) и закончилась через 7 минут после (парковался), `StartTime` и `EndTime` включают эти 12 минут хвостов. `ActiveStartTime` и `ActiveEndTime` — отсекают их (см. раздел 4.11).

### 4.10. Координаты старта и финиша (StartCoord / EndCoord)

**Формула:**

```
StartCoord = { lat: points[0].lat, lon: points[0].lon }                // первая точка записи
EndCoord   = { lat: points[n-1].lat, lon: points[n-1].lon }           // последняя точка записи

ActiveStartCoord = { lat: points[firstMovingIdx].lat,
                     lon: points[firstMovingIdx].lon }                // первая moving-точка
ActiveEndCoord   = { lat: points[lastMovingIdx + 1].lat,
                     lon: points[lastMovingIdx + 1].lon }             // последняя moving-точка
```

Назначение: география старта и финиша. `StartCoord/EndCoord` — для отображения A/B маркеров на карте (включая хвосты — пользователь видит реальную запись). `ActiveStartCoord/ActiveEndCoord` — для метрики `RouteEfficiency` (прямая дистанция start→end), для `routeId` (группировка сессий), для план-факта (запрос маршрута к провайдеру).

> **Почему это важно:** если пользователь включил датчик дома, проехал на работу и стоял там 10 минут, `EndCoord` будет «работа», а `ActiveEndCoord` — тоже «работа» (последняя moving-точка обычно близко к финишу). Но если он по пути заехал на заправку и постоял 20 минут, без концепции ActiveTrip метрики не отличат «финиш маршрута» от «стоянки в середине».

### 4.11. Границы активной поездки (ActiveTrip)

**Назначение:**

Границы активной поездки внутри записи: от первой точки перехода `idle → moving` до последней точки перед `moving → idle`. Эта концепция решает проблему «хвостов» — стоянок в начале записи (включил датчик, но не поехал) и в конце (приехал, но не выключил), которые при расчёте по всей записи искажают `AvgSpeed`, `SpeedP50`, `SpeedDistribution`, `EcoScore`, `DurationDeviation` и сравнительные метрики.

**Формула:**

```
Для результата MotionResult (раздел 4.6):
  firstMovingIdx = первый индекс i где states[i] = "moving"    // если нет → hasActiveTrip = false
  lastMovingIdx  = последний индекс i где states[i] = "moving"

ActiveStartTime = points[firstMovingIdx].timestamp
ActiveEndTime   = points[lastMovingIdx + 1].timestamp
ActiveDuration  = ActiveEndTime − ActiveStartTime             // мс
ActiveStartCoord = { lat: points[firstMovingIdx].lat,  lon: points[firstMovingIdx].lon }
ActiveEndCoord   = { lat: points[lastMovingIdx + 1].lat, lon: points[lastMovingIdx + 1].lon }

preTripIdle  = ActiveStartTime − points[0].timestamp           // мс (хвост в начале)
postTripIdle = points[n-1].timestamp − ActiveEndTime            // мс (хвост в конце)

ActiveIdleTime = IdleTime − (preTripIdle + postTripIdle)        // сек — стоянки внутри поездки

Инвариант: preTripIdle + ActiveDuration + postTripIdle = Duration
```

**Псевдокод:**

```typescript
interface ActiveTrip {
  hasActiveTrip: boolean;
  activeStartTime: number;          // мс
  activeEndTime: number;            // мс
  activeDuration: number;           // сек
  activeStartCoord: { lat: number; lon: number };
  activeEndCoord:   { lat: number; lon: number };
  preTripIdle: number;              // сек — хвост в начале
  postTripIdle: number;             // сек — хвост в конце
  activeIdleTime: number;           // сек — стоянки внутри поездки (светофоры, пробки)
}

function computeActiveTrip(points: GpsPoint[], motion: MotionResult): ActiveTrip {
  const firstMoving = motion.states.findIndex(s => s === 'moving');
  const lastMoving  = motion.states.reduce((acc, s, i) => s === 'moving' ? i : acc, -1);

  if (firstMoving === -1) {
    return {
      hasActiveTrip: false,
      activeStartTime: 0, activeEndTime: 0, activeDuration: 0,
      activeStartCoord: { lat: 0, lon: 0 },
      activeEndCoord:   { lat: 0, lon: 0 },
      preTripIdle: 0, postTripIdle: 0, activeIdleTime: 0,
    };
  }

  const activeStartIdx = firstMoving;
  const activeEndIdx   = lastMoving + 1;

  return {
    hasActiveTrip: true,
    activeStartTime: Number(points[activeStartIdx].timestamp),
    activeEndTime:   Number(points[activeEndIdx].timestamp),
    activeDuration:  (Number(points[activeEndIdx].timestamp) - Number(points[activeStartIdx].timestamp)) / 1000,
    activeStartCoord: { lat: points[activeStartIdx].lat, lon: points[activeStartIdx].lon },
    activeEndCoord:   { lat: points[activeEndIdx].lat,   lon: points[activeEndIdx].lon },
    preTripIdle:  (Number(points[activeStartIdx].timestamp) - Number(points[0].timestamp)) / 1000,
    postTripIdle: (Number(points[points.length - 1].timestamp) - Number(points[activeEndIdx].timestamp)) / 1000,
    activeIdleTime: motion.idleTime
      - (Number(points[activeStartIdx].timestamp) - Number(points[0].timestamp)) / 1000
      - (Number(points[points.length - 1].timestamp) - Number(points[activeEndIdx].timestamp)) / 1000,
  };
}
```

**Граничные случаи:**

| Случай | Поведение |
|---|---|
| Вся запись — стоянка (никогда не двигался) | `hasActiveTrip = false`, все активные поля = 0/null |
| Нет хвоста в начале (сразу поехал) | `preTripIdle = 0` |
| Нет хвоста в конце (закончив запись сразу после остановки) | `postTripIdle = 0` |
| Только 1 moving-интервал | `activeDuration = dt` этого интервала |
| Очень короткая активная поездка (< 60 сек) | активные метрики могут быть `null` (см. EcoScore) |

**Связь с другими метриками:**

| Метрика | Что использует из ActiveTrip |
|---|---|
| AvgSpeed (4.3) | `ActiveDuration` вместо `Duration` |
| SpeedP50, SpeedStdDev, SpeedDistribution (5.1–5.3) | фильтр точек в `[ActiveStartTime, ActiveEndTime]` |
| SpeedVariation (5.6) | фильтр интервалов в активной части |
| ActualDuration (6.2) | `= ActiveDuration` |
| DurationDeviation (6.3) | `(ActiveDuration − PlanDuration) / PlanDuration` |
| EcoScore (7.3) | ускорения считаются только внутри активной части — старт движения = нормальный разгон, не harsh |
| HarshBraking/Accel (7.1, 7.2) | события считаются только внутри активной части |
| RouteAvgDuration, RouteTrafficPattern (10.1, 10.3) | агрегат по `ActiveDuration`, а не по `Duration` |
| routeId (10.0) | использует `ActiveStartCoord` и `ActiveEndCoord` для snap-to-grid |

> **Замечание о нескольких поездках в одной записи:** концепция ActiveTrip берёт **первый** и **последний** moving-интервал. Если внутри записи есть длинные стоянки (заправка, магазин), они попадают в `ActiveIdleTime`. Разбиение записи на несколько сессий намеренно **не реализовано** — это выходит за рамки текущей методологии (см. приложение Г).

## 5. Группа 2. Скоростной анализ (6 метрик)

### 5.1. Медианная скорость (SpeedP50)

**Формула:**

```
SpeedP50 = median([p.speed для всех p в активной части записи
                  где speed != null && speed >= 0])  (м/с)
```

Назначение: типичная скорость поездки. Медиана устойчива к выбросам (в отличие от среднего). Единица: м/с.

> **Фильтр активной части:** в выборку попадают только точки из интервала `[ActiveStartTime, ActiveEndTime]` (раздел 4.11). Стояния-хвосты в начале и конце записи (`speed = 0`) занижали бы медиану: поездка 30 минут на 40 км/ч с 10-минутным хвостом дала бы P50 ≈ 0 км/ч вместо «честных» 40.

**Алгоритм:**

- 1. Отфильтровать точки в `[ActiveStartTime, ActiveEndTime]`.
- 2. Собрать все `speed` в массив (только `speed >= 0`).
- 3. Отсортировать по возрастанию.
- 4. Если длина нечётная — взять средний элемент.
- 5. Если чётная — среднее двух средних элементов.

**Сложность:**

O(n log n) из-за сортировки. Для n=1000 — 10 000 операций, менее 1 мс.

**Граничные случаи:**

- `hasActiveTrip = false` (вся запись — стоянка) → null.
- Все `speed = null` в активной части → null.

### 5.2. Разброс скорости (SpeedStdDev)

**Формула:**

```
SpeedStdDev = sqrt(Σ(speed[i] − mean)² / n)  (м/с)
где mean = Σ speed[i] / n
  выборка — точки в активной части записи со speed != null && speed >= 0
```

Назначение: равномерность движения. Низкое StdDev = плавное вождение, высокое = рваный темп. Единица: м/с.

> **Фильтр активной части:** как и для SpeedP50, берутся только точки из `[ActiveStartTime, ActiveEndTime]`.

**Алгоритм Welford (one-pass):**

Для избежания двух проходов по данным (первый для mean, второй для суммы квадратов) используется алгоритм Welford — вычисляет и mean, и StdDev за один проход с численной устойчивостью:

```
function welfordStdDev(values) { let n = 0, mean = 0, M2 = 0; for (const x of values) { n++; const delta = x - mean; mean += delta / n; M2 += delta * (x - mean); } return n > 0 ? Math.sqrt(M2 / n) : 0; }
```

### 5.3. Распределение скоростей (SpeedDistribution)

**Формула:**

```
SpeedDistribution = {
  "0-20":  count(p в активной части где 0 ≤ speed_kmh < 20),
  "20-40": count(p где 20 ≤ speed_kmh < 40),
  "40-60": count(p где 40 ≤ speed_kmh < 60),
  "60-80": count(p где 60 ≤ speed_kmh < 80),
  "80-100": count(p где 80 ≤ speed_kmh < 100),
  "100+": count(p где speed_kmh ≥ 100)
}
percent[bucket] = count[bucket] / total × 100
Σ percent[bucket] = 100% (обязательно)
```

Назначение: распределение времени по диапазонам скоростей. Единица: количество точек и проценты.

> **Фильтр активной части:** в выборку попадают только точки из `[ActiveStartTime, ActiveEndTime]`. Стояния-хвосты переполняли бы бакет «0–20» и скрывали реальную картину движения.

**Обоснование 6 бакетов:**

Границы соответствуют типичным режимам движения: 0-20 (стоянка, пробка), 20-40 (городской поток), 40-60 (магистраль), 60-80 (пригород), 80-100 (шоссе), 100+ (трасса). Равные шаги 20 км/ч для визуальной симметрии на гистограмме.

**Контроль суммы:**

Σ percent[bucket] должна быть ровно 100% (с учётом округления — 99-101%). Нормализация процентов выполняется после подсчёта: каждый бакет делится на общее число точек выборки. Если сумма выходит за пределы 99-101% — баг в расчёте.

### 5.4. Время в пробках (TimeInTraffic)

**Формула:**

```
TimeInTraffic = Σ dt для интервалов в состоянии "moving" где
  0 < smoothed_speed[i] < 10 км/ч (= 2.78 м/с)   // медленное движение, но не полная стоянка
  (секунды)
```

Назначение: время в пробках (медленное движение, но не стоянка). Единица: секунды.

> **Связь с state machine:** берутся только интервалы в состоянии `moving` (раздел 4.6) со `smoothed_speed` после медианного сглаживания. Это исключает GPS-дрейф на стоянках и медленное «ползание» координат, которые без state machine ложно попадали бы в «пробку». Интервалы-разрывы исключаются автоматически (состояние `gap`).

**Обоснование порога 10 км/ч:**

10 км/ч — граница между «плотным потоком» и «пробкой» в транспортной телематике. Ниже — автомобиль движется со скоростью пешехода, что в городской среде однозначно классифицируется как затор. Выше 10 км/ч — медленное, но уверенное движение. Порог 0 (исключение полной стоянки) отделяет пробку от парковки: стоянка учитывается в IdleTime, пробка — в TimeInTraffic.

### 5.5. Время крейсерского хода (TimeAtCruise)

**Формула:**

```
TimeAtCruise = Σ dt для интервалов в состоянии "moving" где smoothed_speed[i] > 60 км/ч  (секунды)
```

Назначение: время движения на крейсерской скорости (шоссе, трасса). Единица: секунды.

> **Связь с state machine:** условие состояния `moving` отсекает GPS-выбросы (ложное `speed = 80 км/ч` на стоянке не учитывается).

**Обоснование порога 60 км/ч:**

60 км/ч — типичная скорость на городских магистралях и начало загородного режима. Выше — устойчивое движение без светофоров. Используется для оценки загородной части поездки.

### 5.6. Перепады скорости (SpeedVariation)

**Формула:**

```
SpeedVariation = count(i в активной части где |speed[i] − speed[i-1]| > 10 км/ч за 10 сек)  (штуки)
```

Назначение: плавность вождения. Низкое значение = плавное, высокое = рваное (частые торможения/разгоны). Единица: штуки.

> **Фильтр активной части:** события считаются только в активной части записи `[ActiveStartTime, ActiveEndTime]`. Старт движения (0 → 50 км/ч за 10 сек) и финальное торможение (50 → 0) — нормальные манёвры начала и окончания поездки; без фильтра каждый из них добавлял бы по одному ложному событию.

**Обоснование порога 10 км/ч:**

Изменение скорости более 10 км/ч за 10 секунд = ускорение > 0,28 м/с². Это превышает комфортный порог (0,2 м/с²) и воспринимается пассажиром как «рывок». Психология вождения: выше 0,3 м/с² — водитель напрягается. Статистика аварийности: резкие изменения скорости коррелируют с риском ДТП.

**Псевдокод:**

```
const THRESHOLD_KMH = 10; const WINDOW_SEC = 10;
function speedVariation(points, activeTrip) {
  let count = 0;
  for (let i = 1; i < points.length; i++) {
    // фильтр активной части
    if (Number(points[i].timestamp) < activeTrip.activeStartTime ||
        Number(points[i].timestamp) > activeTrip.activeEndTime) continue;
    const dt = (Number(points[i].timestamp) - Number(points[i-1].timestamp)) / 1000;
    if (dt > 0 && dt <= WINDOW_SEC && points[i].speed != null && points[i-1].speed != null) {
      const dSpeed_kmh = Math.abs(points[i].speed - points[i-1].speed) * 3.6;
      if (dSpeed_kmh > THRESHOLD_KMH) count++;
    }
  }
  return count;
}
```

## 6. Группа 3. План-фактный анализ (8 метрик)

План-фактный анализ сравнивает фактически пройденный маршрут с запланированным. Источник плановых данных — результат TrafficJob, который возвращает провайдер маршрутизации (2ГИС, OSRM). Результат содержит: геометрию маршрута (полилиния), плановую дистанцию, плановое время, сегменты с traffic-данными.

### 6.1. Плановое время (PlanDuration)

**Формула:**

```
PlanDuration = Σ segment.planDurationSec по всем сегментам маршрута (секунды) // или напрямую: trafficJob.result.durationSec
```

Назначение: плановое время маршрута от провайдера. Единица: секунды.

> **Важно:** маршрут к провайдеру запрашивается по `ActiveStartCoord` и `ActiveEndCoord` (раздел 4.10), а не по `StartCoord` и `EndCoord`. Это гарантирует, что план соответствует реальной поездке, а не «хвостам» записи.

### 6.2. Фактическое время (ActualDuration)

**Формула:**

```
ActualDuration = ActiveDuration (из раздела 4.11, секунды)
```

Назначение: фактическое время активной поездки. Единица: секунды.

> **Важно:** фактическое время — это `ActiveDuration`, а не `Duration` (вся запись). Иначе стоянка-хвост в начале записи давала бы систематическое завышение `DurationDeviation`: стоянка 10 минут в начале записи = +10 минут к факту = +33% при 30-минутном плане. `ActiveDuration` даёт корректное сравнение с планом. Реализовано в API v2.10.3 (раньше передавалась длительность всей записи — расхождение с методологией).

### 6.3. Отклонение по времени (DurationDeviation)

**Формула:**

```
DurationDeviation = (ActualDuration − PlanDuration) / PlanDuration × 100  (%)
  где ActualDuration = ActiveDuration
// Положительное = дольше плана (пробки)
// Отрицательное = быстрее плана
```

Назначение: процент отклонения фактического времени от планового. Единица: проценты.

**Граничные случаи:**

- `hasActiveTrip = false` → null (нет поездки для сравнения).
- PlanDuration = 0 или null → null (нет плана для сравнения).
- PlanDuration < 0 → null (невалидные данные).
- ActiveDuration = 0 (запись без движения) → null.

### 6.4. Плановая дистанция (PlanDistance)

**Формула:**

```
PlanDistance = Σ segment.planDistance по всем сегментам (метры) // или: trafficJob.result.distanceM
```

### 6.5. Фактическая дистанция (ActualDistance)

**Формула:**

```
ActualDistance = Distance (из базовых метрик, метры)
```

> **v2.10.3:** так как Distance KPI с v2.10.3 считается по активной части (§4.2), `ActualDistance` автоматически согласован с планом, который строится по `ActiveStartCoord → ActiveEndCoord` (§6.1). Аналогично для агрегата периода: Σ активных дистанций поездок.

### 6.6. Отклонение по дистанции (DistanceDeviation)

**Формула:**

```
DistanceDeviation = (ActualDistance − PlanDistance) / PlanDistance × 100 (%)
```

Назначение: процент отклонения фактической дистанции от плановой. Положительное = проехал больше плана (объезд, крюк), отрицательное = короче плана.

**Пример:**

PlanDistance = 124 м (OSRM), ActualDistance = 255 м (факт). DistanceDeviation = (255 − 124) / 124 × 100 = +105,6%. План был короткий (прямая), факт — длинный (реальный город).

### 6.7. Отклонение скорости по сегментам (SpeedDeviation)

**Формула:**

```
SpeedDeviation = (actualSpeed − planSpeed) / planSpeed × 100 (%) где: actualSpeed = segment.actualDistance / segment.actualDuration planSpeed = segment.planDistance / segment.planDuration
```

Назначение: отклонение скорости по каждому сегменту. Единица: проценты. Вычисляется per-segment (сопоставление точек сегментам — HMM map matching, раздел 17.2), агрегация — среднее.

### 6.8. Потери времени из-за пробок (TimeLostToTraffic)

**Формула:**

```
TimeLostToTraffic = Σ (segment.trafficDuration − segment.planDuration) по сегментам где trafficFetched = true (секунды)
```

Назначение: суммарные потери времени из-за пробок. Единица: секунды. Требует traffic-данных от 2ГИС (trafficFetched = true).

**Граничные случаи:**

- Нет сегментов с trafficFetched → 0 (или null).

- trafficDuration < planDuration (быстрее плана) → отрицательный вклад (бонус).

## 7. Группа 4. Поведенческие метрики вождения (10 метрик)

### 7.1. Резкие торможения (HarshBrakingCount)

**Формула:**

```
HarshBrakingCount = count(i в активной части где Δspeed_per_sec < −10 км/ч/сек)
  где Δspeed = (speed[i] − speed[i-1]) × 3.6  (км/ч)
        Δt = (t[i] − t[i-1]) / 1000  (сек)
        Δspeed_per_sec = Δspeed / Δt
```

Назначение: количество резких торможений. Единица: штуки.

> **Фильтр активной части:** события считаются только в активной части записи `[ActiveStartTime, ActiveEndTime]`. Финальное торможение перед парковкой (50 → 0) — нормальный манёвр окончания поездки, а не «резкое торможение».

**Обоснование порога −10 км/ч/сек:**

Замедление 10 км/ч за 1 секунду = 2,78 м/с². Это превышает комфортный порог замедления (2 м/с²) и близко к экстренному торможению (3 м/с²). Статистика страховых: водители с частыми harsh braking имеют на 30% больше страховых случаев. Порог стандартизирован в телематике (Octo Telematics, Progressive Snapshot).

### 7.2. Резкие разгоны (HarshAccelCount)

**Формула:**

```
HarshAccelCount = count(i в активной части где Δspeed_per_sec > +10 км/ч/сек)
```

Назначение: количество резких разгонов. Единица: штуки. Симметрично HarshBraking, но для ускорения.

> **Фильтр активной части:** события считаются только в активной части. Старт движения (0 → 50 км/ч за 5 сек = 36 км/ч/сек) — нормальный разгон с места, а не «резкий».

**Обоснование порога +10 км/ч/сек:**

Ускорение 10 км/ч за 1 сек = 2,78 м/с². Выше комфортного (2 м/с²), типично для «спортивного» стиля. Коррелирует с расходом топлива (+15%) и износом шин/тормозов.

### 7.3. Оценка плавности вождения (EcoScore, CAP-методика)

**Назначение:**

Комплексная оценка качества вождения 0–100. Построена по методике **CAP** (Continuous Acceleration Profiling) из страховой телематики (Octo, Progressive Snapshot): штрафуется **энергия ускорения**, нормированная на расстояние, с насыщающей функцией штрафа.

Требования к методике, которым удовлетворяет CAP:

- **нормировка на длину поездки** — 100 м без событий и 100 км без событий не должны давать одинаковый вклад;
- **нелинейный штраф** — тяжесть манёвра должна учитываться: торможение 100→90 км/ч тяжелее, чем 10→0;
- **насыщение** — штраф ограничен, невозможно «уйти в минус» от одного манёвра;
- **защита от тривиальных данных** — короткие/разреженные записи не оцениваются.

**Формула:**

```
Базовое ускорение (для каждой пары точек i в активной части):
  a[i] = (v[i] - v[i-1]) / dt[i]                                // м/с²
  dt[i] = (t[i] - t[i-1]) / 1000                                // сек

Энергия ускорения (работа на единицу массы):
  BrakingEnergy = Σ a[i]² × dt[i]  для a[i] < 0   // (м/с)²·с
  AccelEnergy   = Σ a[i]² × dt[i]  для a[i] > 0

Нормировка на расстояние:
  BrakingRate = BrakingEnergy / Distance_km
  AccelRate   = AccelEnergy   / Distance_km

Рывок (jerk):
  j[i] = (a[i] - a[i-1]) / dt[i]                                // м/с³
  JerkEnergy  = Σ j[i]² × dt[i]
  JerkRate    = JerkEnergy / Distance_km

Базовые линии (калибруемые параметры, см. «Калибровка базовых линий» ниже):
  BASELINE_BRAKING = 0.5    // (м/с)²·с / км — значения по умолчанию
  BASELINE_ACCEL   = 0.4
  BASELINE_JERK    = 0.3

Насыщающий штраф (сигмоида):
  penalty(actual, baseline) = 1 - 1 / (1 + (actual / baseline)²)

Итог:
  EcoScore = 100 × (1 - 0.45 × penalty(BrakingRate, BASELINE_BRAKING)
                      - 0.30 × penalty(AccelRate,   BASELINE_ACCEL)
                      - 0.25 × penalty(JerkRate,    BASELINE_JERK))
  EcoScore = clamp(EcoScore, 0, 100)
```

Веса 0.45 / 0.30 / 0.25 нормированы на 1.0. Обоснование:
- 0.45 торможение — выше риск столкновения сзади;
- 0.30 разгон — расход топлива;
- 0.25 рывок — комфорт пассажира (ISO 2631-1).

**Калибровка базовых линий:**

`BASELINE_*` — калибруемые параметры, а не константы документа. Штраф интерпретируется относительно «нормальной» езды конкретного водителя (или парка по умолчанию).

Процедура калибровки:

1. **Референсный корпус** — сессии пользователя, удовлетворяющие критериям качества: `hasActiveTrip = true`, `Distance ≥ 5 км`, `ActiveDuration ≥ 5 мин`, `SessionReliability ≥ 0.85` (rating `high`).
2. Для каждой сессии корпуса вычисляются `BrakingRate`, `AccelRate`, `JerkRate` (по формулам выше).
3. **Базовая линия = медиана (P50)** соответствующего rate по корпусу. Медиана, а не среднее — устойчивость к аномальным поездкам в корпусе.
4. **Минимальный размер корпуса — 30 сессий.** Пока корпус < 30, используются значения по умолчанию: 0.5 / 0.4 / 0.3.
5. **Периодичность пересчёта** — раз в месяц либо при пополнении корпуса на 30%.
6. **Ограничения:** базовая линия обязана быть > 0.05 (защита от вырождения — иначе штраф насыщается на любом значении); при невыполнимых данных (пустой корпус, NaN) — значения по умолчанию.
7. **Версионирование:** вместе с результатом EcoScore сохраняется `baselineVersion` (дата калибровки + размер корпуса) — тренды EcoScore сравнимы между поездками, откалиброванными на одной версии базовых линий.

**Псевдокод:**

```typescript
interface EcoScoreBaselines {
  braking: number;   // (м/с)²·с / км
  accel:   number;
  jerk:    number;
  version: string;   // дата калибровки + размер корпуса
  corpusSize: number;
}

const DEFAULT_BASELINES: EcoScoreBaselines = {
  braking: 0.5, accel: 0.4, jerk: 0.3,
  version: 'default', corpusSize: 0,
};

const MIN_CALIBRATION_CORPUS = 30;
const MIN_BASELINE_VALUE = 0.05;

// Калибровка по референсному корпусу (медианы rate'ов)
function calibrateBaselines(
  rates: { braking: number[]; accel: number[]; jerk: number[] },
  isoDate: string,
): EcoScoreBaselines {
  if (rates.braking.length < MIN_CALIBRATION_CORPUS) return DEFAULT_BASELINES;
  const safe = (xs: number[], def: number) => {
    const m = median(xs);                      // P50 с интерполяцией (раздел 16.1)
    return (Number.isFinite(m) && m > MIN_BASELINE_VALUE) ? m : def;
  };
  return {
    braking: safe(rates.braking, DEFAULT_BASELINES.braking),
    accel:   safe(rates.accel,   DEFAULT_BASELINES.accel),
    jerk:    safe(rates.jerk,    DEFAULT_BASELINES.jerk),
    version: `${isoDate}-n${rates.braking.length}`,
    corpusSize: rates.braking.length,
  };
}

function computeEcoScore(
  points: GpsPoint[],
  distanceM: number,
  activeTrip: ActiveTrip,
  baselines: EcoScoreBaselines = DEFAULT_BASELINES,
): EcoScoreResult {
  // Защита от тривиальных данных
  if (!activeTrip.hasActiveTrip || distanceM < 500 || activeTrip.activeDuration < 60 || points.length < 60) {
    return { value: null, brakingRate: 0, accelRate: 0, jerkRate: 0, rating: 'insufficient_data',
             baselineVersion: baselines.version,
             breakdown: { brakingPenalty: 0, accelPenalty: 0, jerkPenalty: 0 } };
  }

  let brakingEnergy = 0, accelEnergy = 0, jerkEnergy = 0;
  let prevA: number | null = null;

  for (let i = 1; i < points.length; i++) {
    // фильтр активной части
    if (Number(points[i].timestamp) < activeTrip.activeStartTime ||
        Number(points[i].timestamp) > activeTrip.activeEndTime) continue;

    const dt = (Number(points[i].timestamp) - Number(points[i - 1].timestamp)) / 1000;
    if (dt <= 0 || dt > 30) { prevA = null; continue; }

    const v0 = points[i - 1].speed;
    const v1 = points[i].speed;
    if (v0 == null || v1 == null || v0 < 0 || v1 < 0) { prevA = null; continue; }

    const a = (v1 - v0) / dt;                                   // м/с²
    const aSqDt = a * a * dt;
    if (a < 0) brakingEnergy += aSqDt;
    else       accelEnergy   += aSqDt;

    if (prevA != null) {
      const j = (a - prevA) / dt;
      jerkEnergy += j * j * dt;
    }
    prevA = a;
  }

  const distanceKm = distanceM / 1000;
  const brakingRate = brakingEnergy / distanceKm;
  const accelRate   = accelEnergy   / distanceKm;
  const jerkRate    = jerkEnergy    / distanceKm;

  const penalty = (actual: number, baseline: number) =>
    1 - 1 / (1 + Math.pow(actual / baseline, 2));

  const brakingPenalty = penalty(brakingRate, baselines.braking);
  const accelPenalty   = penalty(accelRate,   baselines.accel);
  const jerkPenalty    = penalty(jerkRate,    baselines.jerk);

  const score = 100 * (1 - 0.45 * brakingPenalty - 0.30 * accelPenalty - 0.25 * jerkPenalty);

  const value = Math.max(0, Math.min(100, score));
  const rating: EcoScoreRating =
    value >= 80 ? 'excellent' :
    value >= 60 ? 'good' :
    value >= 40 ? 'fair' : 'poor';

  return { value, brakingRate, accelRate, jerkRate, rating,
           baselineVersion: baselines.version,
           breakdown: { brakingPenalty, accelPenalty, jerkPenalty } };
}
```

**Граничные случаи:**

| Случай | Поведение |
|---|---|
| `hasActiveTrip = false` | `null` (insufficient_data) |
| `Distance < 500 м` | `null` |
| `ActiveDuration < 60 сек` | `null` |
| `PointCount < 60` | `null` |
| Все `speed = null` | `null` |
| Один интервал с огромным `dt` (> 30 сек) | пропускается, не входит в сумму |
| Равномерное движение (все `a = 0`) | `brakingRate = accelRate = jerkRate = 0` → `penalty = 0` → `EcoScore = 100` |
| Резкое торможение со 100 км/ч | `brakingEnergy` вклад на порядок больше, чем с 20 км/ч |
| NaN / Infinity | `null` (validate перед clamp) |
| Корпус калибровки < 30 сессий | базовые линии = значения по умолчанию, `baselineVersion = 'default'` |

**Интерпретация значений:**

| EcoScore | Цвет | Интерпретация |
|---|---|---|
| 80–100 | Зелёный | Отличное вождение, плавное, экономичное |
| 60–79 | Жёлтый | Удовлетворительное, есть резкие манёвры |
| 40–59 | Оранжевый | Посредственное, частые торможения/разгоны |
| 0–39 | Красный | Опасное вождение, высокий расход топлива |
| null | Серый | Недостаточно данных |

### 7.4. Интенсивность ускорений (AccelerationRMS)

**Формула:**

```
a[i] = (v[i] - v[i-1]) / dt[i]            // м/с², только для валидных интервалов в активной части
AccelerationRMS = sqrt( Σ a[i]² × dt[i] / Σ dt[i] )    // м/с²
```

Назначение: среднеквадратичное ускорение за активную поездку — непрерывная альтернатива дискретному `SpeedVariation`. Характеризует общую «рваность» движения, нормированную по времени. В отличие от `HarshAccelCount` (бинарный счётчик событий), `AccelerationRMS` учитывает все ускорения, включая малые. Веса по `dt` учитывают переменный sampling rate.

**Псевдокод:**

```typescript
function computeAccelerationRMS(points: GpsPoint[], activeTrip: ActiveTrip): number | null {
  let sumSq = 0, sumDt = 0;
  for (let i = 1; i < points.length; i++) {
    if (Number(points[i].timestamp) < activeTrip.activeStartTime ||
        Number(points[i].timestamp) > activeTrip.activeEndTime) continue;
    const dt = (Number(points[i].timestamp) - Number(points[i - 1].timestamp)) / 1000;
    if (dt <= 0 || dt > 30) continue;
    const v0 = points[i - 1].speed, v1 = points[i].speed;
    if (v0 == null || v1 == null || v0 < 0 || v1 < 0) continue;
    const a = (v1 - v0) / dt;
    sumSq += a * a * dt;
    sumDt += dt;
  }
  if (sumDt === 0) return null;
  return Math.sqrt(sumSq / sumDt);
}
```

**Граничные случаи:**

| Случай | Поведение |
|---|---|
| `hasActiveTrip = false` | `null` |
| `< 2` точек со `speed` в активной части | `null` |
| Все `dt > 30 сек` (только разрывы) | `null` (sumDt = 0) |
| Равномерное движение (все `a = 0`) | `0` |
| NaN / Infinity | `null` |

**Пороги интерпретации:**

| AccelerationRMS, м/с² | Рейтинг |
|---|---|
| < 0.5 | smooth (плавное) |
| 0.5–1.0 | normal |
| 1.0–1.5 | rough (рваное) |
| > 1.5 | aggressive |

### 7.5. Резкость рывков (JerkRMS)

**Формула:**

```
a[i] = (v[i] - v[i-1]) / dt[i]
j[i] = (a[i] - a[i-1]) / dt[i]            // м/с³
JerkRMS = sqrt( Σ j[i]² × dt[i] / Σ dt[i] )   // м/с³
```

Назначение: среднеквадратичный **jerk** (производная ускорения по времени) — мера плавности движения. Прямо связан с комфортом пассажира (ISO 2631-1: укачивание начинается с jerk > 0.5 м/с³). В отличие от `AccelerationRMS`, штрафует **резкость изменения** ускорения, а не само ускорение.

**Псевдокод:**

```typescript
function computeJerkRMS(points: GpsPoint[], activeTrip: ActiveTrip): number | null {
  let sumSq = 0, sumDt = 0;
  let prevA: number | null = null;
  for (let i = 1; i < points.length; i++) {
    if (Number(points[i].timestamp) < activeTrip.activeStartTime ||
        Number(points[i].timestamp) > activeTrip.activeEndTime) continue;
    const dt = (Number(points[i].timestamp) - Number(points[i - 1].timestamp)) / 1000;
    if (dt <= 0 || dt > 30) { prevA = null; continue; }
    const v0 = points[i - 1].speed, v1 = points[i].speed;
    if (v0 == null || v1 == null || v0 < 0 || v1 < 0) { prevA = null; continue; }
    const a = (v1 - v0) / dt;
    if (prevA != null) {
      const j = (a - prevA) / dt;
      sumSq += j * j * dt;
      sumDt += dt;
    }
    prevA = a;
  }
  if (sumDt === 0) return null;
  return Math.sqrt(sumSq / sumDt);
}
```

**Граничные случаи:**

| Случай | Поведение |
|---|---|
| `< 3` точек в активной части со `speed` | `null` |
| После разрыва `dt > 30 сек` | `prevA = null` (jerk не считается через gap) |
| Равномерное движение (все `a = 0`) | `0` |

**Пороги интерпретации:**

| JerkRMS, м/с³ | Рейтинг |
|---|---|
| < 0.5 | comfortable |
| 0.5–1.0 | acceptable |
| 1.0–2.0 | uncomfortable |
| > 2.0 | harsh |

### 7.6. Равномерность скорости (SpeedConsistencyIndex)

**Формула:**

```
SpeedConsistencyIndex = 1 - min(1, SpeedStdDev / AvgSpeed)    // 0..1
  1.0 = идеально равномерное движение (StdDev = 0)
  0.5 = средняя равномерность (StdDev = AvgSpeed / 2)
  0.0 = полное отсутствие равномерности (StdDev ≥ AvgSpeed)
```

Назначение: нормированная равномерность скорости (0..1). В отличие от `SpeedStdDev` (абсолютная величина, м/с), `SpeedConsistencyIndex` **инвариантен к абсолютной скорости**: поездка 100 км/ч со StdDev 10 км/ч и поездка 50 км/ч со StdDev 10 км/ч дадут разные `SpeedStdDev`, но `SpeedConsistencyIndex` правильно покажет: первая поездка более равномерна (10/100 = 0.1 < 10/50 = 0.2).

`min(1, ...)` защищает от отрицательных значений при `StdDev > AvgSpeed`. Расчёт ведётся по точкам активной части записи.

**Псевдокод:**

```typescript
function computeSpeedConsistencyIndex(points: GpsPoint[], activeTrip: ActiveTrip): number | null {
  const speeds = points
    .filter(p => Number(p.timestamp) >= activeTrip.activeStartTime &&
                  Number(p.timestamp) <= activeTrip.activeEndTime)
    .map(p => p.speed)
    .filter((s): s is number => s != null && s >= 0);

  if (speeds.length < 2) return null;

  // Welford для mean и variance (one-pass)
  let n = 0, mean = 0, M2 = 0;
  for (const s of speeds) {
    n++;
    const delta = s - mean;
    mean += delta / n;
    M2 += delta * (s - mean);
  }
  if (n === 0 || mean === 0) return null;

  const stddev = Math.sqrt(M2 / n);
  return Math.max(0, 1 - Math.min(1, stddev / mean));
}
```

**Граничные случаи:**

| Случай | Поведение |
|---|---|
| `hasActiveTrip = false` | `null` |
| `< 2` точек со `speed` в активной части | `null` |
| Все `speed = 0` (стоял) | `null` (AvgSpeed = 0) |
| Все `speed` одинаковые | `1.0` (идеально) |
| `StdDev > AvgSpeed` | `0.0` (clamped) |

**Пороги интерпретации:**

| SpeedConsistencyIndex | Рейтинг |
|---|---|
| > 0.8 | uniform (равномерное) |
| 0.6–0.8 | steady |
| 0.4–0.6 | variable |
| < 0.4 | irregular (рваное) |

### 7.7. Прямолинейность маршрута (BearingConsistency)

**Формула:**

```
Δbearing[i] = angularDelta(bearing[i], bearing[i-1])   // 0..180°, кратчайший путь
  где angularDelta(b1, b2) = min(|b1 - b2|, 360 - |b1 - b2|)

BearingConsistency = 1 - stddev(Δbearing) / 180    // 0..1
  только для интервалов где speed > 5 км/ч (исключая стоянки с шумным bearing)
  в активной части записи
  1.0 = идеально прямо (все Δbearing = 0)
  0.0 = максимальная извилистость (stddev = 180°)
```

Назначение: мера манёвренности маршрута на основе поля `bearing` (направление движения). Низкое значение = прямолинейный маршрут (трасса), высокое = извилистый (город, серпантин). Поле `bearing` собирается приложением и используется этой и следующими метриками (7.8–7.10), а также routeId (10.0).

**Псевдокод:**

```typescript
function computeBearingConsistency(points: GpsPoint[], activeTrip: ActiveTrip): number | null {
  const deltas: number[] = [];
  for (let i = 1; i < points.length; i++) {
    if (Number(points[i].timestamp) < activeTrip.activeStartTime ||
        Number(points[i].timestamp) > activeTrip.activeEndTime) continue;
    const v = points[i].speed;
    if (v == null || v * 3.6 <= 5) continue;       // только при движении

    const b0 = points[i - 1].bearing;
    const b1 = points[i].bearing;
    if (b0 == null || b1 == null) continue;

    const raw = Math.abs(b1 - b0);
    const delta = Math.min(raw, 360 - raw);         // кратчайший путь
    deltas.push(delta);
  }
  if (deltas.length < 2) return null;

  // Welford
  let n = 0, mean = 0, M2 = 0;
  for (const d of deltas) {
    n++;
    const delta = d - mean;
    mean += delta / n;
    M2 += delta * (d - mean);
  }
  const stddev = Math.sqrt(M2 / n);
  return Math.max(0, 1 - stddev / 180);
}
```

**Граничные случаи:**

| Случай | Поведение |
|---|---|
| `< 2` точек с `bearing` при `speed > 5` в активной части | `null` |
| Все `bearing = null` | `null` |
| Все `bearing` одинаковые (прямая) | `1.0` |
| Стоянка (speed < 5) | интервалы пропускаются — `bearing` шумный при нуле |

**Пороги интерпретации:**

| BearingConsistency | Рейтинг |
|---|---|
| > 0.85 | straight (прямолинейный) |
| 0.7–0.85 | moderate |
| 0.5–0.7 | winding (извилистый) |
| < 0.5 | twisty (очень извилистый) |

### 7.8. Развороты (UTurnCount)

**Формула:**

```
event[i] = true  если
  |Δbearing[i]| > 150°  за интервал ≤ 10 сек
  AND speed[i] > 10 км/ч (исключая развороты на месте при стоянке)
  AND dt[i] ≤ 10 сек (исключая долгие интервалы, где bearing мог измениться из-за GPS-дрейфа)
  AND интервал в активной части

UTurnCount = Σ event[i]
```

Назначение: количество разворотов в поездке. Манёвр повышенного риска — пересечение встречной полосы. Использует `bearing`. Стандартная телематическая метрика (используется страховщиками).

**Псевдокод:**

```typescript
const BEARING_UTURN_DEG = 150;
function computeUTurnCount(points: GpsPoint[], activeTrip: ActiveTrip): number {
  let count = 0;
  for (let i = 1; i < points.length; i++) {
    if (Number(points[i].timestamp) < activeTrip.activeStartTime ||
        Number(points[i].timestamp) > activeTrip.activeEndTime) continue;
    const dt = (Number(points[i].timestamp) - Number(points[i - 1].timestamp)) / 1000;
    if (dt <= 0 || dt > 10) continue;
    const v = points[i].speed;
    if (v == null || v * 3.6 <= 10) continue;
    const b0 = points[i - 1].bearing, b1 = points[i].bearing;
    if (b0 == null || b1 == null) continue;
    const raw = Math.abs(b1 - b0);
    const delta = Math.min(raw, 360 - raw);
    if (delta > BEARING_UTURN_DEG) count++;
  }
  return count;
}
```

**Граничные случаи:**

| Случай | Поведение |
|---|---|
| Все `bearing = null` | `0` |
| Стоянка (speed < 10) | не считается |
| Долгий интервал > 10 сек | не считается |
| 2 точки всего | `0` или `1` |

### 7.9. Повороты (TurnCount)

**Формула:**

```
event[i] = true  если
  |Δbearing[i]| > 30°  за интервал ≤ 5 сек
  AND speed[i] > 5 км/ч
  AND |Δbearing[i]| ≤ 150° (не разворот — разворот считается отдельной метрикой 7.8)
  AND dt[i] ≤ 5 сек
  AND интервал в активной части

TurnCount = Σ event[i]
```

Назначение: количество поворотов (меньших, чем разворот). Характеризует сложность маршрута. Использует `bearing`.

**Псевдокод:**

```typescript
const BEARING_TURN_DEG = 30;
function computeTurnCount(points: GpsPoint[], activeTrip: ActiveTrip): number {
  let count = 0;
  for (let i = 1; i < points.length; i++) {
    if (Number(points[i].timestamp) < activeTrip.activeStartTime ||
        Number(points[i].timestamp) > activeTrip.activeEndTime) continue;
    const dt = (Number(points[i].timestamp) - Number(points[i - 1].timestamp)) / 1000;
    if (dt <= 0 || dt > 5) continue;
    const v = points[i].speed;
    if (v == null || v * 3.6 <= 5) continue;
    const b0 = points[i - 1].bearing, b1 = points[i].bearing;
    if (b0 == null || b1 == null) continue;
    const raw = Math.abs(b1 - b0);
    const delta = Math.min(raw, 360 - raw);
    if (delta > BEARING_TURN_DEG && delta <= BEARING_UTURN_DEG) count++;
  }
  return count;
}
```

**Граничные случаи:**

| Случай | Поведение |
|---|---|
| Прямая трасса | `0` |
| Все `bearing = null` | `0` |
| Плавный изгиб дороги (Δbearing < 30°) | не считается (нормальная кривизна дороги) |

### 7.10. Резкие манёвры на высокой скорости (HighSpeedCornering)

**Формула:**

```
event[i] = true  если
  |Δbearing[i]| > 45°  за интервал ≤ 5 сек
  AND speed[i] > 60 км/ч
  AND dt[i] ≤ 5 сек
  AND интервал в активной части

  // Оценка бокового ускорения: a_lat ≈ v² × sin(Δbearing) / L
  // где L — расстояние за интервал. Для упрощения используем порог по bearing+speed.

HighSpeedCornering = Σ event[i]
```

Назначение: количество манёвров на высокой скорости с значительным изменением bearing — индикатор риска потери сцепления. Боковое ускорение > 3 м/с² — стандартный порог в телематике (ISO 2631-1, краш-тесты). Полная формула бокового ускорения требует радиуса поворота, который не считается напрямую. Упрощённая эвристика: `|Δbearing| > 45°` на `speed > 60 км/ч` даёт боковое ускорение > 3 м/с² в большинстве случаев.

**Псевдокод:**

```typescript
const HIGH_SPEED_KMH = 60;
const CORNERING_BEARING_DEG = 45;
function computeHighSpeedCornering(points: GpsPoint[], activeTrip: ActiveTrip): number {
  let count = 0;
  for (let i = 1; i < points.length; i++) {
    if (Number(points[i].timestamp) < activeTrip.activeStartTime ||
        Number(points[i].timestamp) > activeTrip.activeEndTime) continue;
    const dt = (Number(points[i].timestamp) - Number(points[i - 1].timestamp)) / 1000;
    if (dt <= 0 || dt > 5) continue;
    const v = points[i].speed;
    if (v == null || v * 3.6 <= HIGH_SPEED_KMH) continue;
    const b0 = points[i - 1].bearing, b1 = points[i].bearing;
    if (b0 == null || b1 == null) continue;
    const raw = Math.abs(b1 - b0);
    const delta = Math.min(raw, 360 - raw);
    if (delta > CORNERING_BEARING_DEG) count++;
  }
  return count;
}
```

**Граничные случаи:**

| Случай | Поведение |
|---|---|
| Город (speed < 60) | `0` (не применимо) |
| Трасса с плавными поворотами (Δbearing < 45°) | `0` |
| Резкий манёвр на трассе | `1+` |
| Все `bearing = null` | `0` |

**Пороги интерпретации:**

| HighSpeedCornering | Рейтинг |
|---|---|
| 0 | safe |
| 1 | caution |
| 2+ | risky |

## 8. Группа 5. Географические метрики (6 метрик)

### 8.1. Географический охват маршрута (BoundingBox)

**Формула:**

```
BoundingBox = { minLat: min(points.lat), maxLat: max(points.lat), minLon: min(points.lon), maxLon: max(points.lon) }
```

Назначение: прямоугольная область, охватывающая весь маршрут. Единица: градусы. Используется для auto-fit карты и оценки площади покрытия.

**Площадь в км:**

```
width_km = haversine(minLat, minLon, minLat, maxLon) / 1000 height_km = haversine(minLat, minLon, maxLat, minLon) / 1000 area_km2 = width_km × height_km
```

### 8.2. Извилистость маршрута (RouteEfficiency)

**Формула:**

```
RouteEfficiency = Distance / haversine(ActiveStartCoord, ActiveEndCoord)
  1.0 = идеально прямая
  1.5 = средняя извилистость города
  3.0+ = сильный крюк
```

Назначение: отношение фактического пути к прямой дистанции. Единица: безразмерная. Прямая строится по границам активной поездки (раздел 4.10) — стоянки-хвосты не влияют на метрику.

**Обоснование:**

Идеальная прямая невозможна в городе (дороги не прямые). 1.0-1.3 — загородная трасса, 1.3-2.0 — городская магистраль, 2.0+ — сложный городской маршрут с поворотами. Значение > 5 — признак возврата или кругового маршрута.

### 8.3. Перепад высот (AltitudeRange)

**Формула:**

```
AltitudeRange = max(points.altitude) − min(points.altitude) (метры)
```

Назначение: перепад высот между самой низкой и высокой точками. Единица: метры. Только для точек с altitude != null.

### 8.4. Набор высоты (AltitudeGain)

**Формула:**

```
AltitudeGain = Σ max(0, alt[i] − alt[i-1]) для всех i где alt != null (метры)
```

Назначение: суммарный подъём (только положительные изменения высоты). Единица: метры.

**Псевдокод:**

```
function altitudeGain(points) { let gain = 0; let prevAlt = null; for (const p of points) { if (p.altitude != null) { if (prevAlt != null) { const diff = p.altitude - prevAlt; if (diff > 0) gain += diff; } prevAlt = p.altitude; } } return gain; }
```

### 8.5. Доля городской зоны (UrbanRatio)

**Формула:**

```
UrbanRatio = count(p где reverseGeocode(p.lat, p.lon) = urban) / count(points) (0-1)
```

Назначение: proportion городских vs загородных точек. Единица: 0-1. Требует reverse geocoding (через /api/geocode/reverse или внешний сервис).

**Реализация:**

Обратное геокодирование каждой N-й точки (downsample для производительности), определение urban/rural по типу места (city/town = urban, village/hamlet = rural).

### 8.6. Средняя точность GPS (AvgAccuracy)

**Формула:**

```
AvgAccuracy = avg(points.accuracy) для accuracy != null && accuracy >= 0 (метры)
```

Назначение: среднее качество GPS-сигнала. Единица: метры (радиус погрешности). Типично 3-10 м, в худшем случае 50+ м. Используется как σ в HMM map matching (раздел 17.2) и в SessionReliability (раздел 11.6).

## 9. Группа 6. Трафик-метрики (5 метрик)

Трафик-метрики вычисляются на основе данных о пробках, полученных от 2ГИС. Каждый сегмент маршрута содержит: planSpeedKmh (плановая скорость без пробок), trafficSpeedKmh (фактическая скорость с учётом пробок), trafficDuration (время прохождения сегмента с пробками).

### 9.1. Сегменты с данными о пробках (TrafficFetchedSegments)

**Формула:**

```
TrafficFetchedSegments = count(segments где trafficFetched = true)
```

Назначение: покрытие маршрута traffic-данными. Если 0 — трафик не получен (2ГИС недоступен, fallback на OSRM без пробок).

### 9.2. Средняя скорость с учётом пробок (AvgTrafficSpeed)

**Формула:**

```
AvgTrafficSpeed = avg(segment.trafficSpeedKmh) по сегментам с trafficFetched (км/ч)
```

### 9.3. Индекс загруженности (TrafficSeverity)

**Формула:**

```
TrafficSeverity = avg(segment.trafficSpeedKmh / segment.planSpeedKmh) по сегментам с trafficFetched
  1.0 = свободно (фактическая = плановой)
  0.5 = пробка (фактическая вдвое ниже плановой)
  0.0 = глухой затор
```

Назначение: средний индекс загруженности маршрута. Единица: безразмерная (0-1).

**Обоснование:**

Отношение trafficSpeed к planSpeed нормирует данные: 60 км/ч факта vs 90 км/ч плана = 0,67 (лёгкая загрузка), но 30 км/ч факта vs 90 плана = 0,33 (пробка). Без нормализации абсолютные значения не сравнимы между сегментами с разными planSpeed.

### 9.4. Перегруженные сегменты (CongestedSegments)

**Формула:**

```
CongestedSegments = count(segments где TrafficSeverity < 0.5) // т.е. trafficSpeed < planSpeed × 0.5
```

Назначение: количество сегментов с серьёзной пробкой. Единица: штуки.

**Обоснование порога 0.5:**

Скорость ниже половины плановой — это очевидная пробка (водитель едет вдвое медленнее нормы). Порог стандартизирован в транспортной телематике (TomTom Traffic Index, Yandex.Traffic). Порог 0.5 — единое определение «пробки» по всей системе: здесь и в HotspotSegments (раздел 10.6).

### 9.5. Время в заторах (TimeInCongestion)

**Формула:**

```
TimeInCongestion = Σ segment.trafficDuration по сегментам где TrafficSeverity < 0.5 (секунды)
```

Назначение: суммарное время в пробочных участках. Единица: секунды. Отличается от TimeInTraffic (который считает по точкам speed<10 км/ч) — TimeInCongestion считает по сегментам маршрута.

## 10. Группа 7. Сравнительные метрики по маршруту (8 метрик + routeId)

Сравнительные метрики агрегируют данные по всем сессиям с одинаковым `routeId`. Позволяют анализировать типичное поведение маршрута: когда быстрее, когда пробки, ухудшается ли со временем.

### 10.0. Идентификатор маршрута (routeId)

`routeId` — детерминированный хэш, который группирует **концептуально одинаковые** маршруты и разделяет разные маршруты с одинаковыми концами. Без чёткого определения сравнительные метрики (10.1–10.6) некорректны. Это служебный идентификатор, а не метрика: он не отображается пользователю, а используется для группировки.

**Формула:**

```
routeId = sha256(
  snapToGrid(activeStartCoord, GRID_STEP) +
  ":" +
  snapToGrid(activeEndCoord, GRID_STEP) +
  ":" +
  topologyHash
).slice(0, 16)

где:
  GRID_STEP = 0.0005°  (~55 м по широте на широте Москвы)

  snapToGrid(coord, step) = {
    lat: round(coord.lat / step) × step,
    lon: round(coord.lon / step) × step
  }

  topologyHash = sha256(
    sequence of bearing changes at key intersections
  ).slice(0, 8)
```

`topologyHash` вычисляется из сегментов маршрута:
1. Взять ключевые точки маршрута (начало, конец, точки поворота с `|Δbearing| > 60°`).
2. Для каждой ключевой точки — округлённые координаты (`snapToGrid` с тем же `GRID_STEP`).
3. Последовательность ключевых точек хэшируется.

Это даёт:
- одинаковый `routeId` для двух поездок по одному и тому же пути с небольшим отличием в старте/финиша (до 55 м);
- разный `routeId` для двух поездок с одинаковыми концами, но разным путём (объездная vs прямая).

Границы активной поездки (раздел 4.10) гарантируют, что «хвосты» записи не приводят к разным `routeId` для одной и той же поездки.

**Псевдокод:**

```typescript
const GRID_STEP = 0.0005;

function computeRouteId(activeStartCoord, activeEndCoord, segments): string {
  const startGrid = snapToGrid(activeStartCoord);
  const endGrid   = snapToGrid(activeEndCoord);

  const keypoints: string[] = [`${startGrid.lat.toFixed(4)},${startGrid.lon.toFixed(4)}`];

  for (let i = 1; i < segments.length; i++) {
    const b0 = segments[i - 1].bearing, b1 = segments[i].bearing;
    if (b0 != null && b1 != null) {
      const raw = Math.abs(b1 - b0);
      const delta = Math.min(raw, 360 - raw);
      if (delta > 60) {
        const grid = snapToGrid({ lat: segments[i].lat, lon: segments[i].lon });
        keypoints.push(`${grid.lat.toFixed(4)},${grid.lon.toFixed(4)}`);
      }
    }
  }
  keypoints.push(`${endGrid.lat.toFixed(4)},${endGrid.lon.toFixed(4)}`);

  const topologyHash = sha256(keypoints.join("|")).slice(0, 8);
  const routeIdSource = `${startGrid.lat.toFixed(4)},${startGrid.lon.toFixed(4)}:` +
                        `${endGrid.lat.toFixed(4)},${endGrid.lon.toFixed(4)}:` +
                        topologyHash;
  return sha256(routeIdSource).slice(0, 16);
}

function snapToGrid(coord) {
  return {
    lat: Math.round(coord.lat / GRID_STEP) * GRID_STEP,
    lon: Math.round(coord.lon / GRID_STEP) * GRID_STEP,
  };
}
```

**Граничные случаи:**

| Случай | Поведение |
|---|---|
| `segments` пустые (haversine fallback) | `topologyHash = "no_segments"`, routeId всё равно считается по концам |
| Короткая поездка (< 200 м) без поворотов | `keypoints = [start, end]` |
| Кольцевой маршрут (start ≈ end) | `startGrid == endGrid`, но `topologyHash` различает разные кольца |
| `hasActiveTrip = false` | `routeId = null` |

**Хранение:** поле `Session.routeId` (string, indexed). При INSERT сессии: `computeRouteId` от `(activeStartCoord, activeEndCoord, trafficJob.result.segments)`. Для существующих сессий — dogнать одним batch UPDATE.

### 10.1. Среднее, лучшее и худшее время маршрута (RouteAvgDuration / RouteBestDuration / RouteWorstDuration)

**Формулы:**

```
RouteAvgDuration   = avg(activeDuration) по сессиям routeId   (секунды)
RouteBestDuration  = min(activeDuration)
RouteWorstDuration = max(activeDuration)
```

Назначение: типичное, лучшее и худшее время прохождения маршрута. Единица: секунды. Используются для оценки стабильности и диапазона.

> **Важно:** агрегат по `activeDuration` (раздел 4.11), а не по `Duration` (вся запись). Стояния-хвосты в начале/конце записи завышали бы среднее: маршрут 30 минут с типичными хвостами 5+7 минут давал бы Avg ≈ 42 минуты вместо «честных» 30. В агрегат входят только сессии с `SessionReliability ≥ 0.6` (раздел 11.6).

### 10.2. Стабильность времени маршрута (RouteDurationStdDev)

**Формула:**

```
RouteDurationStdDev = stddev(activeDurations) по сессиям routeId  (секунды)
```

Назначение: насколько стабильно время маршрута. Низкое StdDev = предсказуемо, высокое = зависит от внешних факторов (время суток, день недели, пробки).

### 10.3. Зависимость от времени суток (RouteTrafficPattern)

**Формула:**

```
buckets = [0, 3, 6, 9, 12, 15, 18, 21]  // часы
RouteTrafficPattern = { [hour_bucket]: avg(activeDuration) для сессий начатых в этом бакете }
```

Назначение: зависимость длительности от времени суток. Помогает выбрать оптимальное время выезда.

> **Важно:** агрегат по `activeDuration`, бакетирование по `ActiveStartTime` (не по `StartTime`) — стоянка-хвост в начале не смещает бакет.

**Обоснование 8 бакетов по 3 часа:**

3-часовые бакеты группируют похожие периоды: ночь (0-3), раннее утро (3-6), утренний пик (6-9), midday (9-12), обед (12-15), вечерний пик (15-18), вечер (18-21), поздний вечер (21-24). Меньше бакетов — потеря разрешающей способности, больше — недостаточно данных.

### 10.4. Зависимость от дня недели (RouteDayOfWeekPattern)

**Формула:**

```
RouteDayOfWeekPattern = { [понедельник..воскресенье]: avg(activeDuration) для сессий в этот день }
```

Назначение: зависимость длительности от дня недели. Позволяет отличить будни (часы пик) от выходных.

### 10.5. Тренд времени маршрута (RouteTrend, Theil-Sen)

**Формула (Theil-Sen robust regression):**

```
Для каждой пары сессий (i, j) где i < j:
  slope[i][j] = (Y[j] - Y[i]) / (X[j] - X[i])

где X = дата (дни от первой сессии), Y = activeDuration

RouteTrend = median( all slope[i][j] )   // медиана всех попарных наклонов
```

Назначение: тренд длительности маршрута во времени. Единица: секунд/день. Помогает обнаружить ухудшение (новые пробки, ремонт дороги) или улучшение (обход построен).

**Обоснование Theil-Sen (а не МНК):**

МНК чувствителен к выбросам: одна аномалия (пользователь застрял на 3 часа в снегопаде) уводит наклон. Theil-Sen — непараметрический метод, устойчив до 29% выбросов (формальный breakdown point), стандарт в robust statistics.

**Сложность:**

`O(n²)` для полных попарных наклонов — неприемлемо для n > 1000. Решение: для n > 200 использовать bootstrap-выборку из 200 случайных пар.

```
if (n <= 200)  // точный Theil-Sen
  slopes = all pairwise slopes
else           // bootstrap Theil-Sen
  slopes = 200 случайных попарных наклонов

RouteTrend = median(slopes)
```

> **Детерминированность bootstrap:** выборка пар генерируется PRNG с seed, вычисленным из входных данных (хэш дат сессий, FNV-1a → mulberry32). Никакого `Math.random()` без seed: повторный расчёт на тех же сессиях даёт идентичный `RouteTrend` — соблюдён принцип идемпотентности (раздел 2).

**Дополнительно (опционально):**
- `intercept = median(Y) - RouteTrend × median(X)` — для предсказаний: `Y = slope × X + intercept`
- Доверительный интервал 95%: из перцентилей `slopes`: `[percentile(slopes, 2.5), percentile(slopes, 97.5)]`

**Псевдокод:**

```typescript
// Детерминированный PRNG: одинаковый вход → одинаковая выборка пар
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a: seed из входных данных (дат сессий), не из системных часов
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function computeRouteTrendTheilSen(
  sessions: { date: Date; activeDurationSec: number }[]
): RouteTrendResult {
  if (sessions.length < 2) return { slope: null, intercept: null, ci95: null, rating: 'insufficient_data' };

  const firstDate = sessions[0].date.getTime();
  const X = sessions.map(s => (s.date.getTime() - firstDate) / 86_400_000);
  const Y = sessions.map(s => s.activeDurationSec);

  const n = sessions.length;
  const useAll = n <= 200;
  const sampleSize = useAll ? (n * (n - 1)) / 2 : 200;
  const rand = mulberry32(fnv1a(X.join(',')));   // seed из входных данных

  const slopes: number[] = [];
  if (useAll) {
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const dX = X[j] - X[i];
        if (dX === 0) continue;
        slopes.push((Y[j] - Y[i]) / dX);
      }
  } else {
    // детерминированный bootstrap: ровно sampleSize валидных наклонов
    let attempts = 0;
    while (slopes.length < sampleSize && attempts < sampleSize * 4) {
      attempts++;
      const i = Math.floor(rand() * n);
      const j = Math.floor(rand() * n);
      if (i === j) continue;
      const dX = X[j] - X[i];
      if (dX === 0) continue;
      slopes.push((Y[j] - Y[i]) / dX);
    }
  }

  if (slopes.length === 0) return { slope: null, intercept: null, ci95: null, rating: 'insufficient_data' };

  slopes.sort((a, b) => a - b);
  const slope = median(slopes);
  const intercept = median(Y) - slope * median(X);
  const ci95 = { lower: percentile(slopes, 2.5), upper: percentile(slopes, 97.5) };

  const rating: RouteTrendRating =
    Math.abs(slope) < 0.5 ? 'stable' :
    slope > 0 ? 'worsening' : 'improving';

  return { slope, intercept, ci95, rating };
}
```

**Граничные случаи:**

| Случай | Поведение |
|---|---|
| `< 2` сессий | `null` (insufficient_data) |
| Все durations одинаковые | `slope = 0`, rating `stable` |
| 1 аномалия 3 часа | не влияет на медиану (устойчивость) |
| Все X одинаковые (сессии в один день) | `slopes = []`, `null` |
| Повторный расчёт тех же данных | идентичный результат (seed из входных данных) |

### 10.6. Хронически пробочные участки (HotspotSegments)

**Формула:**

```
Для каждого сегмента s маршрута routeId:
  severities_s = [session_traffic_severity[s] for session in routeId sessions]

  если |severities_s| > 0:
    P75_severity = percentile(severities_s, 75)   // 75-й перцентиль
    P25_severity = percentile(severities_s, 25)

HotspotSegments = [
  { segment_id, P75_severity, P25_severity, congestedSessionCount, totalSessionCount }
  для сегментов s где P75_severity < 0.5
]
```

Назначение: сегменты маршрута, которые хронически пробочные (не эпизодически). Единица: штуки.

`P75 < 0.5` означает: в 75% поездок TrafficSeverity был ниже 0.5 (т.е. пробка была чаще, чем в 1 из 4 поездок).

**Обоснование перцентиля (а не среднего):**

Среднее чувствительно к выбросам — одна поездка без пробки вытягивала бы среднее выше порога, и хронический участок выпадал бы из списка. 75-й перцентиль устойчив: одна аномально хорошая поездка не вытягивает P75. Порог 0.5 соответствует `CongestedSegments` (раздел 9.4) — единое определение «пробки» по всей системе.

Дополнительно:
- `congestedSessionCount` — сколько поездок имели `TrafficSeverity < 0.5` (для UI «15 из 20 поездок»);
- `worstSeverity` — минимальное значение (самая тяжёлая пробка на этом сегменте).

**Псевдокод:**

```typescript
function computeHotspotSegments(history: SegmentSeverityHistory[]): HotspotSegmentsResult[] {
  const hotspots: HotspotSegmentsResult[] = [];

  for (const h of history) {
    if (h.severities.length === 0) continue;

    const sorted = [...h.severities].sort((a, b) => a - b);
    const p75 = percentile(sorted, 75);
    const p25 = percentile(sorted, 25);
    const worst = sorted[0];
    const congestedCount = sorted.filter(s => s < 0.5).length;
    const totalCount = sorted.length;

    if (p75 < 0.5) {
      hotspots.push({
        segmentId: h.segmentId, p75, p25, worstSeverity: worst,
        congestedSessionCount: congestedCount, totalSessionCount: totalCount,
      });
    }
  }

  // Сортировка по «тяжести»: чем ниже P75 — тем хроничнее пробка
  hotspots.sort((a, b) => a.p75 - b.p75);
  return hotspots;
}
```

**Граничные случаи:**

| Случай | Поведение |
|---|---|
| 0 сессий по сегменту | сегмент пропускается |
| 1 сессия | `P75 = P25 =` значение, возможно в hotspots |
| Все severity > 0.5 | не входит в hotspots |
| 1 аномально хорошая поездка | не вытягивает P75 (устойчивость) |

## 11. Группа 8. Метрики качества данных (6 метрик)

### 11.1. Плотность точек (PointDensity)

**Формула:**

```
PointDensity = PointCount / Duration (точек/мин)
```

Назначение: плотность записи GPS. Типично 1 точка/сек = 60 точек/мин. Низкая плотность = разреженная запись, снижает точность метрик.

**Граничные случаи:**

- Duration = 0 → null.

### 11.2. Количество разрывов (GapCount)

**Формула:**

```
GapCount = count(i где (t[i] − t[i-1]) > 30 000 мс) (штуки)
```

Назначение: количество разрывов в записи более 30 секунд. Единица: штуки. Порог совпадает с `GapTime` в state machine (раздел 4.6) и фильтрацией в разделе 3.3 — единое определение разрыва по всему документу.

**Обоснование порога 30 сек:**

30 секунд — типичный интервал между точками при нормальной записи (1 Гц = 1 сек). Разрыв более 30 сек означает потерю сигнала (тоннель, подземный паркинг) или приостановку приложения. Порог взят из практики GPS-аналитики (Strava, Garmin Connect используют 30-90 сек).

### 11.3. Суммарная длительность разрывов (GapTotalDuration)

**Формула:**

```
GapTotalDuration = Σ (t[i] − t[i-1] − 30 000) для i где (t[i] − t[i-1]) > 30 000 (мс)
```

Назначение: суммарное потерянное время из-за пропусков. Единица: миллисекунды (или секунды).

### 11.4. Точность GPS P90 (AccuracyP90)

**Формула:**

```
AccuracyP90 = percentile(points.accuracy, 90) (метры)
```

Назначение: 90-й перцентиль точности GPS — худшее качество в топ-10% точек. Единица: метры. Показывает, насколько плох GPS в худшие моменты.

**Алгоритм расчёта перцентиля:**

```
function percentile(values, p) { if (values.length === 0) return null; const sorted = [...values].sort((a, b) => a - b); const idx = (p / 100) * (sorted.length - 1); const lo = Math.floor(idx); const hi = Math.ceil(idx); if (lo === hi) return sorted[lo]; // Линейная интерполяция return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo); }
```

**Обоснование P90 (а не среднего или максимума):**

P90 показывает качество в худшие 10% случаев, игнорируя топ-1% экстремальных выбросов (которые могут быть артефактами). Среднее скрывает худшие случаи, максимум слишком чувствителен к единичным сбоям. P90 — стандарт в SRE-практике (Service Level Objective).

### 11.5. Полнота записи (CompletenessScore)

**Формула:**

```
CompletenessScore = 1 − GapTotalDuration / Duration (0-1)
  1.0 = идеальная запись без пропусков
  0.9 = 10% времени потеряно
  0.5 = половина записи потеряна
  0.0 = полностью потеряна
```

Назначение: оценка полноты записи. Единица: 0-1 (безразмерная).

**Граничные случаи:**

- Duration = 0 → 1.0 (тривиально полная, хотя данных нет).

- GapTotalDuration > Duration (clock skew) → max(0, ...).

### 11.6. Индекс доверия к записи (SessionReliability)

**Назначение:**

Общий индекс доверия к данным сессии (0..1). Комбинирует три аспекта: полнота записи, отсутствие GPS-дрейфа, физическая правдоподобность. Используется для:
- фильтрации битых сессий из сравнительных метрик (`RouteAvgDuration`, `RouteTrend` и др.);
- показа пользователю «достоверность этой поездки»;
- отметки сессий для ручного QA-ревью.

**Формула:**

```
SessionReliability = CompletenessScore × driftScore × PlausibilityScore   (0..1)

где:
  CompletenessScore — существующая метрика (11.5), 0..1
  driftScore        = max(0, 1 − StationaryDrift / AvgAccuracy)            (0..1)
  PlausibilityScore = (count of valid points) / (total points)            (0..1)

  StationaryDrift — max displacement между соседними точками в состоянии "idle"
                    (по state machine из раздела 4.6; интервалы-разрывы в состоянии
                    "gap" не учитываются — большое смещение через разрыв легитимно), м
  AvgAccuracy     — существующая метрика (8.6), м

  если AvgAccuracy = 0 или null (нет данных о точности):
    driftScore = 1.0 (нейтральный множитель, не штрафуем за отсутствие данных)

Метрика не определена (null) при < 2 точках: нет ни одного интервала,
оценивать нечего (см. граничные случаи).
```

`PlausibilityScore` — доля точек, прошедших физические проверки:

```
точка валидна, если:
  speed ≤ 200 км/ч (SPEED_MAX_PLAUSIBLE)
  accuracy ≤ 50 м (ACCURACY_BAD) или accuracy = null
  haversine(p[i-1], p[i]) ≤ speed × dt + 2 × max(prevAccuracy, accuracy)
       (перемещение не превышает физически возможное)
  |Δaltitude| ≤ 100 м/сек (нет телепортаций по высоте)
```

**Псевдокод:**

```typescript
const SPEED_MAX_PLAUSIBLE_KMH = 200;
const ACCURACY_BAD_M = 50;

function computeSessionReliability(
  points: GpsPoint[],
  completenessScore: number,
  movingTimeResult: MotionResult,
): SessionReliabilityResult {
  // < 2 точек — нет интервалов, сессия не оценивается
  if (points.length < 2) {
    return { value: null, completenessScore: null, driftScore: null,
             plausibilityScore: null, rating: 'insufficient_data' };
  }

  // 1. Drift score — только по интервалам в состоянии "idle" (не "gap")
  const avgAccuracy = computeAvgAccuracy(points) ?? 0;
  let stationaryDrift = 0;
  for (let i = 1; i < points.length; i++) {
    if (movingTimeResult.states[i - 1] === 'idle') {
      const disp = haversine(points[i - 1], points[i]);
      stationaryDrift = Math.max(stationaryDrift, disp);
    }
  }
  const driftScore = avgAccuracy > 0
    ? Math.max(0, 1 - stationaryDrift / avgAccuracy)
    : 1.0;

  // 2. Plausibility score
  let validCount = 0;
  for (let i = 0; i < points.length; i++) {
    if (isPlausiblePoint(points, i)) validCount++;
  }
  const plausibilityScore = validCount / points.length;

  // 3. Composite
  const value = Math.max(0, Math.min(1,
    completenessScore * driftScore * plausibilityScore));

  const rating: SessionReliabilityRating =
    value >= 0.85 ? 'high' :
    value >= 0.6  ? 'medium' :
    value >= 0.3  ? 'low' : 'unreliable';

  return { value, completenessScore, driftScore, plausibilityScore, rating };
}

function isPlausiblePoint(points: GpsPoint[], i: number): boolean {
  const p = points[i];
  if (p.speed != null && p.speed * 3.6 > SPEED_MAX_PLAUSIBLE_KMH) return false;
  if (p.accuracy != null && p.accuracy > ACCURACY_BAD_M) return false;
  if (i > 0) {
    const prev = points[i - 1];
    const dt = (Number(p.timestamp) - Number(prev.timestamp)) / 1000;
    if (dt > 0 && p.speed != null && prev.accuracy != null && p.accuracy != null) {
      const disp = haversine(prev, p);
      const maxDisp = p.speed * dt + 2 * Math.max(prev.accuracy, p.accuracy);
      if (disp > maxDisp) return false;
    }
    if (p.altitude != null && prev.altitude != null) {
      const dAlt = Math.abs(p.altitude - prev.altitude);
      if (dt > 0 && dAlt / dt > 100) return false;   // > 100 м/сек нереалистично
    }
  }
  return true;
}
```

**Граничные случаи:**

| Случай | Поведение |
|---|---|
| 0 или 1 точка | `null` (insufficient_data) — нет интервалов, оценивать нечего |
| Все `accuracy = null` | `driftScore = 1.0` (нейтральный), plausibility проверяет только speed |
| Все `accuracy > 50 м` (плохой GPS) | `plausibilityScore = 0` → `value = 0` |
| Сильный GPS-дрейф на стоянке | `driftScore → 0` → `value → 0` |
| Большие разрывы | `completenessScore → 0` → `value → 0` |
| Смещение через разрыв (gap) | не штрафуется в driftScore (интервалы gap исключены) |

**Интерпретация:**

| SessionReliability | Рейтинг | Использование |
|---|---|---|
| ≥ 0.85 | high | входит во все агрегаты |
| 0.6–0.85 | medium | входит в агрегаты, показывать с пометкой |
| 0.3–0.6 | low | НЕ входит в агрегаты, показывать в списке |
| < 0.3 | unreliable | НЕ входит в агрегаты, помечать для QA |
| null | insufficient_data | не входит в агрегаты, отображается серым |

## 12. Логика расчёта на сервере

Полный пайплайн обработки GPS-данных от ingest до отображения метрик:

### 12.1. Пайплайн

```
1\. Sensor Logger → POST /api/ingest (Bearer INGEST_TOKEN) ↓ 2. Middleware: auth, rate-limit (120/мин), payload-size (256 КБ) ↓ 3. Zod-валидация: lat ∈ [−90,90], lon ∈ [−180,180], speed ≥ 0, ... ↓ 4. Идемпотентность: SELECT по (deviceId, clientId) ↓ (если есть — вернуть duplicate:true) 5. INSERT Session + GpsPoint[] (нормализация ts ns→ms) ↓ 6. CREATE TrafficJob (status='pending') ↓ 7. Worker poll (каждые 5 сек) → UPDATE ... RETURNING (атомарный захват) ↓ 8. routeRequest(start, end): 2ГИС → OSRM → haversine ↓ 9. traffic-fetch (если 2ГИС): segments с trafficSpeed ↓ 10. UPDATE TrafficJob SET result=JSON(...), status='completed' ↓ 11. UPDATE Session SET status='completed' ↓ 12. Frontend: GET /api/sessions/[id]/stats → расчёт метрик ↓ 13. Frontend: отображение (KPI tiles, charts, summary)
```

### 12.2. Расчёт метрик: when и where

| **Метрика**                            | **Где считается**                     | **Когда**                              |
|----------------------------------------|---------------------------------------|----------------------------------------|
| Базовые (Duration, Distance, ...)      | Server (/api/sessions/[id]/stats)   | On-demand при открытии сессии          |
| Скоростные (P50, StdDev, Distribution) | Server                                | On-demand                              |
| План-фактные                           | Server (из trafficJob.result)         | После завершения TrafficJob            |
| Поведенческие (EcoScore)               | Server                                | On-demand (требует HarshBraking/Accel) |
| Географические                         | Server                                | On-demand                              |
| Трафик-метрики                         | Server (из segments)                  | После traffic-fetch                    |
| Сравнительные (Route*)                | Server (/api/routes/[id]/analytics) | On-demand по маршруту                  |
| Качество данных                        | Server                                | On-demand                              |

## 13. Цепочка маршрутизации

### 13.1. 2ГИС carrouting 6.0.0

Primary провайдер. API endpoint: https://routing.api.2gis.ru/carrouting/6.0.0?key=API_KEY. Параметры: start (lat,lon), end (lat,lon). Возвращает: геометрию (polyline), distanceM, durationSec, segments[] с traffic-данными. Таймаут: 8 секунд. Требует TWO_GIS_API_KEY.

### 13.2. OSRM Demo Server

Fallback. URL: https://router.project-osrm.org/route/v1/driving/. Параметры: coordinates, overview=full, geometries=geojson. Возвращает: geometry, distance, duration. Без traffic-данных. Таймаут: 8 секунд.

### 13.3. Гаверсинус (40 км/ч)

Last resort. Distance = haversine(start, end). Duration = distance / (40/3.6) = distance × 0.09 сек. Полилиния = [start, end] (прямая линия). Без segments, без traffic.

**Обоснование 40 км/ч:**

40 км/ч — средняя скорость в городском потоке с учётом светофоров и пробок. Статистика: средняя скорость по Москве 38 км/ч, по Санкт-Петербургу 36 км/ч (Яндекс.Пробки 2024). 40 — круглое число с запасом. Альтернативы — 30 (пессимистично, переоценивает время) или 50 (оптимистично, недооценивает).

### 13.4. Snap-to-grid кэш

Для уменьшения запросов к провайдерам результаты кэшируются. Ключ кэша: hash(snap-to-grid(start, end) + tod_bucket).

**Snap-to-grid:**

Округление координат до сетки. Шаг сетки: ~55 м по широте (0.0005 градуса), ~35 м по долготе (на широте Москвы). Погрешность приемлема: 55 м — меньше типичной городской улицы. Две точки в одной ячейке — одинаковый маршрут.

**Time-of-day бакеты:**

8 бакетов по 3 часа: 0, 3, 6, 9, 12, 15, 18, 21. Пробки зависят от времени суток — один и тот же маршрут в час пик и ночью имеет разное duration. Кэш с tod_bucket возвращает релевантный результат.

## 14. Кэширование маршрутов

Двухуровневое кэширование: in-memory LRU (быстро, ограниченный размер) + SQLite persistent (долго, без ограничения).

| **Уровень** | **Хранилище**       | **Размер**   | **TTL** | **Invalidate** |
|-------------|---------------------|--------------|---------|----------------|
| L1          | In-memory Map (LRU) | 1000 записей | 5 мин   | по времени     |
| L2          | RouteCache (SQLite) | без лимита   | 24 часа | по expiresAt   |

При запросе маршрута: check L1 → check L2 → запрос к провайдеру → запись в L1 и L2. Hit ratio: типично 60-80% для повторяющихся маршрутов (дом-работа).

## 15. Идемпотентность

Идемпотентность — свойство повторного запроса возвращать тот же результат. Реализована через (deviceId, clientId) в Session.

**Алгоритм:**

```
1\. ingest приходит с deviceId + clientId 2. SELECT * FROM Session WHERE deviceId = ? AND clientId = ? 3. Если найдена — вернуть { sessionId, duplicate: true } (HTTP 200) 4. Если не найдена — INSERT, создать TrafficJob, вернуть { sessionId, duplicate: false } (HTTP 201)
```

**Влияние на метрики:**

Идемпотентность гарантирует: одна поездка = один расчёт. Повторная отправка того же пакета не создаёт дубль сессии, не запускает новый TrafficJob, не дублирует метрики. Это критично для агрегатов (RouteAvgDuration и др.). Требование идемпотентности распространяется и на расчёт метрик: все случайные элементы (bootstrap в RouteTrend) детерминированы через seed из входных данных (раздел 10.5).

## 16. Агрегация и статистика

### 16.1. Функции агрегации

| **Функция**             | **Формула**                                       | **Сложность** |
|-------------------------|----------------------------------------------------|---------------|
| count                   | COUNT(*)                                          | O(n)          |
| sum                     | Σ x[i]                                           | O(n)          |
| avg                     | Σ x[i] / n                                       | O(n)          |
| min                     | min(x[i])                                        | O(n)          |
| max                     | max(x[i])                                        | O(n)          |
| median (P50)            | sorted[n/2]                                      | O(n log n)    |
| percentile (P25, P75, P90) | sorted[n×p/100] с интерполяцией                | O(n log n)    |
| stddev                  | sqrt(Σ(x-μ)²/n) — Welford one-pass                 | O(n)          |
| Theil-Sen regression    | median попарных наклонов (bootstrap для n > 200)   | O(n²) / O(200)|
| HMM map matching (17.2) | Viterbi по сегментам × точкам                     | O(N × M × K)  |

### 16.2. Курсорная пагинация

Для больших выборок (более 1000 сессий) — курсорная пагинация. Вместо OFFSET (медленно на больших смещениях) — WHERE id < ? ORDER BY startTime DESC LIMIT 20. Cursor = ID последней записи предыдущей страницы.

### 16.3. Downsample для визуализации

Графики и карты не могут отрисовать 10 000 точек эффективно. Downsample: если точек > 500, берётся каждая N-я точка (N = ceil(n/500)). Для метрик расчёта downsample НЕ применяется — используются все точки.

## 17. План-фактный анализ: детали

### 17.1. Сегментация маршрута

Маршрут от провайдера — это массив `segments[]`. Каждый `segment`: `{ id, lat, lon, planSpeed, trafficSpeed, planDuration, trafficDuration, distance, nextSegmentIds, bearing }`. Сегменты соответствуют участкам дороги между поворотами. Поле `nextSegmentIds` — список достижимых следующих сегментов (топология), отдаётся провайдером 2ГИС и OSRM по умолчанию. Поле `bearing` — направление сегмента, опционально усиливает HMM.

### 17.2. Соответствие точек сегментам (HMM map matching)

GPS-точки сессии сопоставляются с сегментами плана через **HMM (Hidden Markov Model) map matching** — стандарт индустрии (GraphHopper, Valhalla, OSRM snap-to-road, Mapbox Map Matching API).

**Почему не сопоставление по ближайшей точке:**

Простое сопоставление по ближайшей точке (nearest-point) не учитывает:
- направления движения (bearing);
- топологии дорожной сети (точка может «перепрыгнуть» на параллельную дорогу в 20 м);
- истории предыдущих точек (нет сглаживания последовательных решений).

На перекрёстках и параллельных дорогах это даёт систематические ошибки: точка на путепроводе «прилипает» к дороге под ним, точки на дублере «перепрыгивают» на магистраль. HMM с Viterbi-декодером даёт наиболее вероятную последовательность сегментов с учётом и близости, и топологии, и истории.

**Модель:**

```
Скрытые состояния:   сегменты маршрута  S = {s_0, s_1, ..., s_m}
Наблюдения:          GPS-точки         O = {o_0, o_1, ..., o_n}

Эмиссионная вероятность (точность измерения):
  p(o_i | s_j) = (1 / sqrt(2π σ²)) × exp(-d²(o_i, s_j) / (2 σ²))
  где d(o, s) — расстояние от точки до сегмента (haversine до ближайшей точки сегмента)
       σ — средняя GPS-погрешность (= AvgAccuracy, типично 5 м)

Transition probability (топологическая):
  p(s_j → s_k) = (1 / β) × exp(-Δ_route(s_j, s_k) / β)  если s_k достижима из s_j
                 0                                       иначе
  где Δ_route(s_j, s_k) — разница между:
       haversine(o_i-1, o_i)  (фактическое расстояние между точками)
       route_distance(s_j, s_k)  (расстояние по маршруту)
       (большая разница = маловероятный переход)
       β — параметр (типично 5–10 м)

Декодирование: алгоритм Viterbi
  V[i][s] = max over (V[i-1][s'] × p(s'→s) × p(o_i | s))
  Назначение: каждой GPS-точке → наиболее вероятный сегмент
```

**Псевдокод:**

```typescript
function hmmMapMatch(
  points: GpsPoint[],
  segments: Segment[],
  sigma: number = 5,     // GPS-погрешность, м
  beta: number = 5,       // transition parameter, м
): { segmentPerPoint: (number | null)[]; probabilities: number[] } {
  if (points.length === 0 || segments.length === 0) {
    return { segmentPerPoint: [], probabilities: [] };
  }

  const N = points.length, M = segments.length;
  const V: number[][]   = Array.from({ length: N }, () => new Array(M).fill(-Infinity));
  const back: number[][] = Array.from({ length: N }, () => new Array(M).fill(-1));

  // Init: первая точка
  for (let j = 0; j < M; j++) {
    const d = haversineToSegment(points[0], segments[j]);
    V[0][j] = Math.log(emissionProb(d, sigma));
  }

  // Recursion
  for (let i = 1; i < N; i++) {
    const dt = (Number(points[i].timestamp) - Number(points[i - 1].timestamp)) / 1000;
    if (dt > 30) {
      // разрыв: сбросить Viterbi, начать заново
      for (let j = 0; j < M; j++) {
        const d = haversineToSegment(points[i], segments[j]);
        V[i][j] = Math.log(emissionProb(d, sigma));
        back[i][j] = -1;
      }
      continue;
    }
    const disp = haversine(points[i - 1], points[i]);

    for (let k = 0; k < M; k++) {
      const d = haversineToSegment(points[i], segments[k]);
      const emit = Math.log(emissionProb(d, sigma));

      let maxLogProb = -Infinity, bestPrev = -1;
      for (let j = 0; j < M; j++) {
        if (V[i - 1][j] === -Infinity) continue;
        if (!segments[j].nextSegmentIds.includes(k)) continue;   // только достижимые

        const routeDist = routeDistance(segments, j, k);
        const transitionLogProb = Math.log(transitionProb(Math.abs(routeDist - disp), beta));
        const total = V[i - 1][j] + transitionLogProb;
        if (total > maxLogProb) { maxLogProb = total; bestPrev = j; }
      }
      V[i][k] = emit + maxLogProb;
      back[i][k] = bestPrev;
    }
  }

  // Backtrack
  const segmentPerPoint: (number | null)[] = new Array(N).fill(null);
  let bestFinal = -1, maxFinal = -Infinity;
  for (let j = 0; j < M; j++) {
    if (V[N - 1][j] > maxFinal) { maxFinal = V[N - 1][j]; bestFinal = j; }
  }
  segmentPerPoint[N - 1] = bestFinal;
  for (let i = N - 1; i > 0; i--) {
    if (segmentPerPoint[i] == null) continue;
    segmentPerPoint[i - 1] = back[i][segmentPerPoint[i]!];
  }
  return { segmentPerPoint, probabilities: V[N - 1] };
}

function emissionProb(distance: number, sigma: number): number {
  return (1 / Math.sqrt(2 * Math.PI * sigma * sigma)) *
         Math.exp(-(distance * distance) / (2 * sigma * sigma));
}
function transitionProb(delta: number, beta: number): number {
  return (1 / beta) * Math.exp(-delta / beta);
}
```

**Производительность:**

Сложность `O(N × M × K)`, где `K` — среднее число достижимых следующих сегментов (обычно 2–4).
- Типичная поездка: 1000 точек × 50 сегментов × 3 = 150 000 операций ≈ 5 мс.
- Длинная поездка (10 000 точек): ~50 мс — приемлемо для on-demand расчёта.

**Что нужно от провайдера:**

- Поле `segments[].nextSegmentIds` — список достижимых следующих сегментов (топология). 2ГИС и OSRM отдают это по умолчанию.
- Поле `segments[].bearing` — опционально, усиливает эмиссионную вероятность (сравнение bearing точки и сегмента).

### 17.3. Edge cases

- Сессия без плана (TrafficJob failed) — все план-факт метрики = null.

- Провайдер = haversine (нет segments) — Segments tab пуст, DurationDeviation = null.

- Частичный план (OSRM без traffic) — PlanDuration/PlanDistance есть, TrafficSeverity = null.

- Разрыв > 30 сек — Viterbi сбрасывается и стартует заново с следующей точки (не «тянется» через gap).

## 18. Визуализация метрик

| **Метрика**            | **Где**                   | **Формат**            | **Цвет**                                  |
|------------------------|---------------------------|-----------------------|-------------------------------------------|
| Duration               | KPI tile, header, Summary  | N мин / N сек         | нейтральный                               |
| ActiveDuration         | Summary (мелким)          | N мин                 | нейтральный, подпись «в поездке»          |
| Distance               | KPI tile, Summary          | N.NN км               | нейтральный                               |
| AvgSpeed               | KPI tile, Summary          | N.N км/ч              | нейтральный                               |
| MaxSpeed               | KPI tile, Summary          | N.N км/ч              | зелёный ≤60, жёлтый 60-100, красный >100  |
| EcoScore               | KPI tile                   | 0-100                 | зелёный ≥80, жёлтый 60-79, красный <60    |
| EcoScore breakdown     | Tab «Вождение»            | 3 прогресс-бара       | то же, + диаграмма-радар                  |
| AccelerationRMS        | Tab «Вождение» (KPI)       | N.NN м/с²             | < 0.5 зелёный, 0.5–1.5 жёлтый, > 1.5 красный |
| JerkRMS                | Tab «Вождение» (KPI)       | N.NN м/с³             | < 0.5 зелёный, 0.5–2.0 жёлтый, > 2.0 красный |
| SpeedConsistencyIndex  | Tab «Скорость» (KPI)       | 0.NN + прогресс-бар   | > 0.8 зелёный, 0.4–0.8 жёлтый, < 0.4 красный |
| BearingConsistency     | Tab «Маршрут» (KPI)        | 0.NN                  | > 0.85 зелёный, 0.5–0.85 жёлтый, < 0.5 красный |
| UTurnCount             | Tab «Вождение» (KPI)       | N                     | 0 зелёный, 1 жёлтый (U-turn иконка), 2+ красный |
| TurnCount              | Tab «Маршрут» (KPI)        | N поворотов           | нейтральный (информативная)               |
| HighSpeedCornering     | Tab «Вождение» (KPI)       | N                     | 0 зелёный, 1 жёлтый, 2+ красный (иконка заноса) |
| DistanceDeviation      | KPI tile, Deviations       | +N% / -N%             | зелёный ≤5%, жёлтый 5-15%, красный >15%   |
| TimeInTraffic          | KPI tile                   | N мин                 | нейтральный                               |
| SpeedDistribution      | Speed tab, Analytics       | гистограмма 6 бакетов | 4 цвета по скорости                       |
| AltitudeGain           | Altitude tab, Summary      | N м                   | нейтральный                               |
| RouteTrend             | Routes details             | линейный график + CI  | зелёный <0, красный >0                   |
| HotspotSegments        | Routes details             | список сегментов      | жёлтая иконка, шкала по worstSeverity     |
| SessionReliability      | Summary                    | N% + 3 мини-бара      | > 0.85 зелёный, 0.6–0.85 жёлтый, 0.3–0.6 оранжевый, < 0.3 красный; null — серый |
| MotionTimeline         | Tab «Скорость»             | stacked bar timeline  | зелёный (moving) / серый (idle) / жёлтый (gap) |

## 19. Граничные случаи и обработка ошибок

| **Случай**                  | **Поведение**                                                  | **Где**     |
|-----------------------------|----------------------------------------------------------------|-------------|
| 0 точек                     | Все метрики = 0 или null, hasActiveTrip=false, SessionReliability=null (insufficient_data) | stats route |
| 1 точка                     | Duration=0, Distance=0, AvgSpeed=null, hasActiveTrip=false, SessionReliability=null (insufficient_data) | stats route |
| Все speed=null              | Speed-метрики=null, EcoScore=null, AccelerationRMS=null       | stats route |
| Все altitude=null           | Altitude-метрики=null                                          | stats route |
| Все bearing=null            | Bearing-метрики=null, UTurn/Turn/HighSpeedCornering=0          | stats route |
| accuracy=−1                 | Игнорируется в AvgAccuracy, AccuracyP90                        | stats route |
| timestamp=0                 | Фильтруется (невалидный)                                       | ingest      |
| deltaTime=0                 | Пропускается (деление на ноль)                                 | stats route |
| Infinity / NaN              | Заменяется на null                                             | stats route |
| Пустой segments             | Segments tab: «нет данных», Deviations: null                  | frontend    |
| trafficFetched=false        | Traffic-метрики=null                                           | stats route |
| Вся запись — стоянка        | hasActiveTrip=false, все активные метрики=null                 | stats route |
| Только хвосты (нет moving)  | hasActiveTrip=false, AvgSpeed=null, EcoScore=null              | stats route |
| GPS-дрейф на стоянке        | cross-check отсекает, IdleTime корректен, SessionReliability↓  | stats route |
| Разрыв > 30 сек             | GapTime (states='gap'), Viterbi сбрасывается, RouteTrend/HotspotSegments устойчивы | stats route |
| NaN / Infinity в EcoScore   | value=null, rating=insufficient_data                           | stats route |
| Все bearing=одинаковые      | BearingConsistency=1.0, UTurnCount=0, TurnCount=0             | stats route |
| Аномальная поездка 3 часа   | RouteTrend (Theil-Sen) устойчив, не уводит наклон              | stats route |
| Все severity>0.5 для сегмента | Сегмент не входит в HotspotSegments                          | stats route |

## 20. Точность и погрешности

| **Метрика**                        | **Погрешность**                   | **Причина**                                          |
|------------------------------------|-----------------------------------|------------------------------------------------------|
| GPS lat/lon                        | ±3-10 м (типично), ±50 м (худшее) | Спутниковая геометрия, многолучёвость                |
| GPS speed                          | ±0,1 м/с (0,36 км/ч)              | Doppler effect измерение                             |
| GPS altitude                       | ±10-30 м (хуже lat/lon)           | Геоидная модель, спутниковая геометрия               |
| Haversine distance                 | ±0,5%                             | Сферическая аппроксимация (Земля не идеальная сфера) |
| AvgSpeed (от Distance/Duration)    | ±0,5% + ошибка Distance           | Накопленная погрешность Distance                     |
| Duration                           | ±1 мс                             | Точность системного таймера                          |
| Accumulated Distance (Σ haversine) | ±1-3%                             | Накопление погрешностей точек                        |

Для типичной поездки 10 км суммарная погрешность Distance: ±100-300 м. При AvgSpeed = 50 км/ч погрешность: ±0,5-1,5 км/ч. Для EcoScore (CAP) погрешность определяется погрешностью GPS-speed (±0,1 м/с) и усредняется по всей дистанции — систематического накопления нет.

## 21. Производительность расчётов

| **Метрика**                 | **Сложность**    | **Время для n=1000** |
|-----------------------------|------------------|----------------------|
| Duration                    | O(1)             | <0,1 мс              |
| Distance                    | O(n)             | 0,5 мс               |
| AvgSpeed                    | O(1) от Distance | <0,1 мс              |
| MaxSpeed                    | O(n)             | 0,2 мс               |
| MovingTime (state machine)  | O(n)             | 0,5 мс               |
| ActiveTrip                  | O(n)             | 0,1 мс (от states[]) |
| SpeedP50 (median)           | O(n log n)        | 1,5 мс (sort)        |
| SpeedStdDev (Welford)       | O(n)             | 0,4 мс               |
| SpeedDistribution           | O(n)             | 0,3 мс               |
| SpeedVariation              | O(n)             | 0,4 мс               |
| HarshBraking/Accel          | O(n)             | 0,4 мс               |
| EcoScore (CAP)              | O(n)             | 0,5 мс               |
| AccelerationRMS             | O(n)             | 0,3 мс               |
| JerkRMS                     | O(n)             | 0,3 мс               |
| SpeedConsistencyIndex       | O(n)             | 0,4 мс               |
| BearingConsistency          | O(n)             | 0,4 мс               |
| UTurnCount                  | O(n)             | 0,2 мс               |
| TurnCount                   | O(n)             | 0,2 мс               |
| HighSpeedCornering          | O(n)             | 0,2 мс               |
| BoundingBox                 | O(n)             | 0,2 мс               |
| AltitudeGain                | O(n)             | 0,3 мс               |
| AccuracyP90                 | O(n log n)        | 1,5 мс (sort)        |
| SessionReliability          | O(n)             | 0,5 мс               |
| RouteTrend (Theil-Sen, n=200) | O(n²)          | ~0,4 мс (200×199/2)  |
| RouteTrend (Theil-Sen, n>200, bootstrap) | O(200) | ~0,1 мс     |
| HMM map matching (n=1000, m=50) | O(N×M×K=150k) | ~5 мс            |
| HotspotSegments             | O(S × P log P)   | < 1 мс (S сегментов, P поездок) |
| Итого (все метрики, n=1000) | O(n log n)        | ~12 мс            |

Батчинг: /api/sessions/batch-stats принимает до 10 sessionId, считает метрики параллельно. Кэширование: результаты могут кэшироваться в Session.statsJson (поле) для повторного использования без пересчёта.

## 22. Приёмка методики

Чек-лист соответствия методики:

- Все 62 метрики и служебный идентификатор routeId реализованы по формулам из этого документа.
- Ни одной заглушки «—» для вычислимых метрик.

**Базовые и активная поездка:**
- MovingTime — гистерезис 5/2 км/ч + cross-check по displacement + debounce 5 сек.
- Контрольная сумма `MovingTime + IdleTime + GapTime = Duration` выполняется.
- Каждый интервал записи учитывается ровно один раз (нет двойного счёта debounce-окна, нет потерянного начального idle).
- `states[]` содержит значения `idle | moving | gap` и имеет длину `points.length − 1`.
- ActiveTrip вычисляется, `hasActiveTrip=false` корректно обрабатывается (все активные метрики = null).
- AvgSpeed использует `ActiveDuration`, не `Duration`.
- IdleTime считается независимо (не через `Duration − MovingTime`).

**Скоростные:**
- SpeedP50, SpeedStdDev, SpeedDistribution — фильтр по `[ActiveStartTime, ActiveEndTime]`.
- TimeInTraffic/TimeAtCruise — через state machine, не по `speed[i] > threshold`.
- SpeedVariation — только в активной части.

**План-факт:**
- ActualDuration = ActiveDuration.
- DurationDeviation = `(ActiveDuration − PlanDuration) / PlanDuration × 100`.
- Маршрут к провайдеру запрашивается по `ActiveStartCoord` / `ActiveEndCoord`.
- Map matching — HMM (Viterbi), не nearest-point. Разрыв > 30 сек сбрасывает Viterbi.

**Поведенческие:**
- EcoScore — CAP-методика (энергия ускорения, нормировка на расстояние, сигмоида).
- Калибровка базовых линий EcoScore выполнена по процедуре раздела 7.3; с результатом сохраняется `baselineVersion`.
- EcoScore возвращает null при `Distance < 500 м` или `ActiveDuration < 60 сек` или `PointCount < 60`.
- HarshBraking/Accel — только в активной части.
- AccelerationRMS, JerkRMS, SpeedConsistencyIndex, BearingConsistency — реализованы.
- UTurnCount, TurnCount, HighSpeedCornering — реализованы, используют `bearing`.

**Сравнительные:**
- routeId вычисляется по `computeRouteId(activeStartCoord, activeEndCoord, segments)` — snap-to-grid + topologyHash.
- RouteAvgDuration/Best/Worst/StdDev/TrafficPattern — агрегат по `activeDuration`.
- RouteTrafficPattern бакетируется по `ActiveStartTime`.
- RouteTrend — Theil-Sen с bootstrap для n > 200, CI 95%; bootstrap детерминирован (seed из входных данных) — повторный расчёт даёт идентичный результат.
- HotspotSegments — `P75 < 0.5`.

**Качество данных:**
- SessionReliability вычисляется и используется для фильтрации агрегатов.
- SessionReliability = null при < 2 точках (insufficient_data).
- Сессии с `rating = unreliable` исключаются из `RouteAvgDuration` и др.

**Единые пороги:**
- Разрыв записи — 30 сек (разделы 3.3, 4.6, 11.2, 17.2).
- SpeedDistribution — 6 бакетов, сумма = 100%.
- TimeInTraffic — порог 10 км/ч (не IdleTime proxy).
- HarshBraking/Accel — порог 10 км/ч/сек.
- AccuracyP90 — 90-й перцентиль с интерполяцией.
- Пробка — TrafficSeverity < 0.5 (CongestedSegments и HotspotSegments).

**Граничные случаи:**
- Граничные случаи (0/1 точка, null, Infinity, вся запись — стоянка, GPS-дрейф) обрабатываются согласно таблице в разделе 19.

**Тесты:**
- Все метрики имеют unit-тесты с эталонными данными.
- Тесты на контрольную сумму `MovingTime + IdleTime + GapTime = Duration`.
- Тесты на инвариант `preTripIdle + ActiveDuration + postTripIdle = Duration`.
- Тесты на debounce: всплеск 2–3 сек не меняет состояние; интервалы неподтверждённого кандидата приписаны прежнему состоянию.
- Тесты на устойчивость RouteTrend к 1 аномалии (Theil-Sen).
- Тесты на устойчивость HotspotSegments к 1 аномалии (P75).
- Тесты на детерминированность RouteTrend: два расчёта на одних данных дают идентичный результат.
- Тесты на каталог: число метрик в коде = 62 + routeId (приложение А).

## 23. Приложения

## Приложение А. Полный каталог метрик (62 метрики + routeId)

| **№** | **Название**                          | **Идентификатор**       | **Группа**    | **Единица**   |
|-------|---------------------------------------|-------------------------|---------------|---------------|
| 1     | Длительность записи                   | Duration                | Базовые       | сек           |
| 2     | Дистанция                             | Distance                | Базовые       | м             |
| 3     | Средняя скорость                      | AvgSpeed                | Базовые       | м/с           |
| 4     | Максимальная скорость                 | MaxSpeed                | Базовые       | м/с           |
| 5     | Рекорд скорости за всё время          | MaxSpeedAllTime         | Базовые       | м/с           |
| 6     | Время в движении                      | MovingTime              | Базовые       | сек           |
| 7     | Время стоянок                         | IdleTime                | Базовые       | сек           |
| 8     | Количество точек                      | PointCount              | Базовые       | шт            |
| 9     | Время начала                          | StartTime               | Базовые       | дата          |
| 10    | Время окончания                       | EndTime                 | Базовые       | дата          |
| 11    | Координаты старта                     | StartCoord              | Базовые       | lat,lon       |
| 12    | Координаты финиша                     | EndCoord                | Базовые       | lat,lon       |
| 13    | Границы активной поездки              | ActiveTrip              | Базовые       | composite     |
| 14    | Медианная скорость                    | SpeedP50                | Скоростные    | м/с           |
| 15    | Разброс скорости                      | SpeedStdDev             | Скоростные    | м/с           |
| 16    | Распределение скоростей               | SpeedDistribution       | Скоростные    | %             |
| 17    | Время в пробках                       | TimeInTraffic           | Скоростные    | сек           |
| 18    | Время крейсерского хода               | TimeAtCruise            | Скоростные    | сек           |
| 19    | Перепады скорости                     | SpeedVariation          | Скоростные    | шт            |
| 20    | Плановое время                        | PlanDuration            | План-факт     | сек           |
| 21    | Фактическое время                     | ActualDuration          | План-факт     | сек           |
| 22    | Отклонение по времени                 | DurationDeviation       | План-факт     | %             |
| 23    | Плановая дистанция                    | PlanDistance            | План-факт     | м             |
| 24    | Фактическая дистанция                 | ActualDistance          | План-факт     | м             |
| 25    | Отклонение по дистанции               | DistanceDeviation       | План-факт     | %             |
| 26    | Отклонение скорости по сегментам      | SpeedDeviation          | План-факт     | %             |
| 27    | Потери времени из-за пробок           | TimeLostToTraffic       | План-факт     | сек           |
| 28    | Резкие торможения                     | HarshBrakingCount       | Поведенческие | шт            |
| 29    | Резкие разгоны                        | HarshAccelCount         | Поведенческие | шт            |
| 30    | Оценка плавности вождения             | EcoScore                | Поведенческие | 0-100         |
| 31    | Интенсивность ускорений               | AccelerationRMS         | Поведенческие | м/с²          |
| 32    | Резкость рывков                       | JerkRMS                 | Поведенческие | м/с³          |
| 33    | Равномерность скорости                | SpeedConsistencyIndex   | Поведенческие | 0-1           |
| 34    | Прямолинейность маршрута              | BearingConsistency      | Поведенческие | 0-1           |
| 35    | Развороты                             | UTurnCount              | Поведенческие | шт            |
| 36    | Повороты                              | TurnCount               | Поведенческие | шт            |
| 37    | Резкие манёвры на высокой скорости    | HighSpeedCornering      | Поведенческие | шт            |
| 38    | Географический охват маршрута         | BoundingBox             | География     | град          |
| 39    | Извилистость маршрута                 | RouteEfficiency         | География     | —             |
| 40    | Перепад высот                         | AltitudeRange           | География     | м             |
| 41    | Набор высоты                          | AltitudeGain            | География     | м             |
| 42    | Доля городской зоны                   | UrbanRatio              | География     | 0-1           |
| 43    | Средняя точность GPS                  | AvgAccuracy             | География     | м             |
| 44    | Сегменты с данными о пробках          | TrafficFetchedSegments  | Трафик        | шт            |
| 45    | Средняя скорость с учётом пробок      | AvgTrafficSpeed         | Трафик        | км/ч          |
| 46    | Индекс загруженности                  | TrafficSeverity         | Трафик        | 0-1           |
| 47    | Перегруженные сегменты                | CongestedSegments       | Трафик        | шт            |
| 48    | Время в заторах                       | TimeInCongestion        | Трафик        | сек           |
| 49    | Идентификатор маршрута (служебный)    | routeId                 | Сравнительные | string        |
| 50    | Среднее время маршрута                | RouteAvgDuration        | Сравнительные | сек           |
| 51    | Лучшее время маршрута                 | RouteBestDuration       | Сравнительные | сек           |
| 52    | Худшее время маршрута                 | RouteWorstDuration      | Сравнительные | сек           |
| 53    | Стабильность времени маршрута         | RouteDurationStdDev     | Сравнительные | сек           |
| 54    | Зависимость от времени суток          | RouteTrafficPattern     | Сравнительные | сек/бакет     |
| 55    | Зависимость от дня недели             | RouteDayOfWeekPattern   | Сравнительные | сек/день      |
| 56    | Тренд времени маршрута                | RouteTrend              | Сравнительные | сек/день      |
| 57    | Хронически пробочные участки          | HotspotSegments         | Сравнительные | шт            |
| 58    | Плотность точек                       | PointDensity            | Качество      | точек/мин     |
| 59    | Количество разрывов                   | GapCount                | Качество      | шт            |
| 60    | Суммарная длительность разрывов       | GapTotalDuration        | Качество      | сек           |
| 61    | Точность GPS P90                      | AccuracyP90             | Качество      | м             |
| 62    | Полнота записи                        | CompletenessScore       | Качество      | 0-1           |
| 63    | Индекс доверия к записи               | SessionReliability      | Качество      | 0-1           |

> Примечание: позиция 49 (`routeId`) — служебный идентификатор для группировки сессий, а не метрика. Итого: 62 метрики + 1 идентификатор = 63 позиции каталога. Счёт по группам: Базовые 13, Скоростные 6, План-факт 8, Поведенческие 10, География 6, Трафик 5, Сравнительные 8 (+routeId), Качество 6.

## Приложение Б. Глоссарий

| **Термин**                       | **Определение**                                                        |
|----------------------------------|------------------------------------------------------------------------|
| Гаверсинус                       | Формула расчёта расстояния между двумя точками на сфере по координатам |
| Перцентиль P90                   | Значение, ниже которого находится 90% наблюдений                       |
| Перцентиль P75                   | Значение, ниже которого находится 75% наблюдений; используется в HotspotSegments |
| Стандартное отклонение (StdDev)  | Мера разброса значений вокруг среднего                                 |
| Медиана (P50)                    | Среднее значение в отсортированном массиве                             |
| МНК (метод наименьших квадратов) | Метод линейной регрессии, минимизирующий сумму квадратов отклонений; чувствителен к выбросам |
| Theil-Sen regression             | Непараметрическая робастная регрессия; устойчива до 29% выбросов        |
| Welford algorithm                | Однопроходный алгоритм вычисления дисперсии с численной устойчивостью  |
| HMM (Hidden Markov Model)        | Стохастическая модель с скрытыми состояниями; для map matching       |
| Viterbi algorithm                | Динамическое программирование для декодирования наиболее вероятной последовательности состояний HMM |
| Emission probability             | Вероятность наблюдения при данном скрытом состоянии (для HMM)          |
| Transition probability           | Вероятность перехода между скрытыми состояниями (для HMM)             |
| CAP (Continuous Acceleration Profiling) | Методика скоринга водителя через энергию ускорения, нормированную на расстояние |
| Jerk                             | Производная ускорения по времени, м/с³; мера комфорта пассажира        |
| ActiveTrip                       | Интервал записи от первого до последнего moving-интервала; отсекает «хвосты» |
| ActiveDuration                   | Длительность активной поездки; используется в аналитических метриках вместо Duration |
| PreTripIdle / PostTripIdle       | Стояния в начале и конце записи (хвосты), не входящие в активную поездку |
| Snap-to-grid                     | Округление координат до сетки для кэширования и routeId               |
| TopologyHash                     | Хэш последовательности ключевых точек маршрута; компонент routeId       |
| routeId                          | Детерминированный хэш, группирующий одинаковые маршруты для сравнительных метрик |
| Time-of-day бакет                | 3-часовой диапазон времени для кэширования пробок                      |
| Circuit breaker                  | Защитный механизм, размыкающий цепь при отказах                        |
| Идемпотентность                  | Свойство повторного запроса возвращать тот же результат                |
| Downsample                       | Уменьшение количества точек для визуализации                           |
| Soft-delete                      | Мягкое удаление с возможностью восстановления                          |
| Grace period                     | Период после soft-delete до физического удаления                       |
| RPO/RTO                          | Recovery Point/Time Objective — целевые метрики восстановления         |
| SLO/SLI                          | Service Level Objective/Indicator — целевые уровни сервиса             |
| GPS-дрейф                        | Медленное «ползание» координат при нулевой скорости; отсекается cross-check по displacement |
| State machine (MovingTime)       | Конечный автомат с состояниями idle/moving/gap, гистерезисом и debounce |
| Гистерезис                       | Двухпороговый механизм, предотвращающий «мигание» состояния на границе |
| Cross-check (MovingTime)         | Сравнение GPS-скорости с displacement-скоростью для отсева дрейфа      |
| Debounce                         | Минимальная длительность состояния перед переходом; отсекает краткие всплески |
| Gap (разрыв записи)              | Интервал между соседними точками более 30 сек; потеря данных, не стоянка |
| Базовая линия (EcoScore)         | Калибруемый параметр CAP: медианное значение энергии ускорений по референсному корпусу поездок |
| Референсный корпус               | Набор сессий с высоким SessionReliability, по которому калибруются базовые линии EcoScore |
| Seed (PRNG)                      | Начальное состояние генератора псевдослучайных чисел; при фиксированном seed выборка воспроизводима |

## Приложение В. Список литературы

- Sinnott, R.W. (1984). "Virtues of the Haversine". Sky and Telescope. 68 (2): 159.
- Welford, B.P. (1962). "Note on a method for calculating corrected sums of squares and products". Technometrics. 4 (3): 419–420.
- Montgomery, D.C., Runger, G.C. (2018). Applied Statistics and Probability for Engineers. Wiley.
- Transportation Research Board (2010). Highway Capacity Manual. TRB.
- ISO 2631-1:1997. Mechanical vibration and shock — Evaluation of human exposure to whole-body vibration.
- TomTom Traffic Index (2024). Methodology report.
- Theil, H. (1950). "A rank-invariant method of linear and polynomial regression analysis". Proc. Kon. Ned. Akad. v. Wetensch. 53: 386–392, 521–525, 1397–1412.
- Sen, P.K. (1968). "Estimates of the regression coefficient based on Kendall's tau". JASA. 63 (324): 1379–1389.
- Newson, P., Krumm, J. (2009). "Hidden Markov Map Matching Through Noise and Sparseness". GIS '09: Proc. 17th ACM SIGSPATIAL Int. Conf. on Advances in Geographic Information Systems: 336–343.
- Viterbi, A.J. (1967). "Error bounds for convolutional codes and an asymptotically optimum decoding algorithm". IEEE Trans. Inf. Theory. 13 (2): 260–269.

## Приложение Г. Ограничения методологии (out of scope)

Намеренно не реализовано в рамках текущей методологии:

- **Разбиение записи на несколько поездок.** Концепция ActiveTrip берёт первый и последний moving-интервал, не разбивая запись. Если в середине записи есть длительная стоянка (заправка, магазин), она попадает в `ActiveIdleTime`, но сессия остаётся единой.
- **Нормализация по сегментам (segment-to-segment) между разными провайдерами** маршрутизации.
- **Учёт timezone** для `RouteDayOfWeekPattern` (бакетирование по UTC).
- **Требование минимального размера выборки** для сравнительных метрик (кроме фильтра по SessionReliability).
- **Сегмент-сегментное сравнение** между разными сессиями.

Эти пункты могут быть рассмотрены в будущих версиях документа.
