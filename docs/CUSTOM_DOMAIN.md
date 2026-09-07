# Подключение собственного домена (доступ из РФ без VPN)

`*.onrender.com` внесён в реестр РКН (у части провайдеров дополнительно фильтруется
диапазон 216.24.57.0/24) — из РФ сервис напрямую недоступен. Решение: свой домен
через Cloudflare-проксирование. Проверено по коду: CSP домен-независимая,
cookie `__Host-` (host-only, без Domain), share-ссылки строятся от
`window.location.origin` — **правки кода не требуются**.

## Порядок (≈30 минут)

1. **Купить домен** (любой регистратор: reg.ru, Cloudflare Registrar, Namecheap;
   подойдёт самый дешёвый, `.ru`/`.com`/`.xyz`). Если домен куплен не в Cloudflare —
   добавить зону в Cloudflare (бесплатный план) и сменить NS у регистратора на выданные
   Cloudflare.

2. **Render: добавить домен.** Dashboard → сервис `telemetria-poedzok` →
   Settings → Custom Domains → Add → ввести домен (напр. `gps.example.ru`).
   Render покажет CNAME-цель вида `telemetria-poedzok.onrender.com`.

3. **Cloudflare: DNS.** Добавить запись CNAME: имя `gps` (или `@` для апекса —
   CNAME Flattening), цель — CNAME из Render. **Прокси сначала выключить**
   (серое облако, DNS only) — Render должен пройти верификацию и выпустить
   Let's Encrypt-сертификат (статус в том же разделе Custom Domains → Verify).

4. **Cloudflare: включить проксирование.** После статуса Verified — включить
   оранжевое облако. SSL/TLS → режим **Full (strict)** (иначе цикл редиректов).
   Опционально: Enable Always Use HTTPS.

5. **SensorLogger: сменить URL инжеста.** В приложении на телефоне заменить
   `https://telemetria-poedzok.onrender.com/api/ingest` на
   `https://<домен>/api/ingest` (Bearer INGEST_TOKEN не меняется). Без этого
   телефон продолжит слать данные в заблокированный хост.

6. **Проверка:**
   - из РФ без VPN: `https://<домен>/health` → `{"status":"ok",...}`;
   - браузер: вход, «Аналитика», «Поездки»;
   - следующая поездка: точки приходят (диагностика `diag.ingest.trace` в Setting).

## Нюансы

- Cloudflare-кэширование ответов API: у всех API-ответов уже стоят нужные
  заголовки (`Cache-Control`/`no-store` — см. http-utils), кэшировать нечему;
  при проблемах — Rules → Bypass Cache для `/api/*`.
- Rate-limit инжеста считается по IP клиента: за Cloudflare клиенты приходят
  с IP edge-узлов CF — X-Forwarded-For берётся ПОСЛЕДНИЙ (AUDIT B-9), т.е.
  реальный IP клиента. Логика не меняется.
- Render free засыпание: пока активен cron-pinger (внешний планировщик на
  песочнице) — сервис не спит. После переезда на домен пингер продолжает
  стучать в onrender-URL напрямую (сервер один и тот же).
