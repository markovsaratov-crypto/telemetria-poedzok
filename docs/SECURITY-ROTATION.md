# Ранбук ротации секретов (v2.38.1, ревью F1/F2)

> **Статус на 18.09.2026 (после деплоя v2.39.1-воркера):** fix-паки задеплоены
> на прод (Render, CI success, откат — ветка `backup/pre-fixpacks-2026-09-17`);
> хардненый d1-gateway-воркер (вайтлист/лимиты/rate-limit + §B1 `/ingest` +
> §B2 `/kvcache`) ЗАДЕПЛОЕН на Cloudflare 18.09 (рунбук деплоя —
> `cloudflare-worker/wrangler.toml`). Ротация секретов ещё НЕ выполнена — весь
> ранбук ниже остаётся обязательным: секрет шлюза в git-истории (коммит
> `25bd1bd`) считается скомпрометированным до ротации; вычистка истории
> (шаг 10) подготовлена filter-repo, применяется force-push'ем.

> **Причина:** секрет D1-шлюза был закоммичен в публичный репозиторий
> (`.env.production.local`, коммит `25bd1bd`), а все прод-секреты — в
> plaintext-таблице «пазворты.xlsx» вне репо. По правилам проекта
> (OPERATIONS.md §C-1, п.4) все перечисленные значения считаются
> **скомпрометированными** и подлежат ротации.
>
> В документе — ТОЛЬКО имена секретов. Значений не пишем нигде и никогда.

## 0. Порядок действий (важно)

Ротировать за один сеанс, в этом порядке:

1. Ротировать `D1_GATEWAY_SECRET` (шаг 1) — компромет = полный доступ к БД.
2. Ротировать остальные секреты (шаги 2–8) — все они лежали в xlsx.
3. Уничтожить xlsx (шаг 9).
4. Вычистить секрет из git-истории (шаг 10) — до этого репо остаётся
   «дырявым» даже с ротированным секретом (история публично клонируется).
5. Проверить (шаг 11).

Автостраховка на будущее: `scripts/check-secrets.sh` (упав в коммит/CI,
не даст повторить инцидент) и харденинг шлюза
`cloudflare-worker/d1-gateway.js` (вайтлист операций + лимит тела +
rate-limit — даже с украденным секретом DROP/ATTACH/чужие таблицы невозможны).

---

## 1. D1_GATEWAY_SECRET

- **Где живёт:** (а) переменная `GATEWAY_SECRET` воркера
  `d1-gateway` (Cloudflare Workers), (б) env `D1_GATEWAY_SECRET` сервиса
  `telemetria-poedzok` на Render (сейчас — в `.env.production.local`,
  см. шаг 10), (в) в git-истории (компромисс, см. шаг 10).
- **Как ротировать:**
  1. Сгенерировать новое значение (`openssl rand -hex 32`).
  2. Cloudflare Dashboard → Workers → `d1-gateway` → Settings →
     Variables → `GATEWAY_SECRET` = новое значение → Deploy.
  3. Render → сервис `telemetria-poedzok` → Environment →
     `D1_GATEWAY_SECRET` = то же значение (после шага 10 секрет живёт
     ТОЛЬКО здесь, не в файле).
  4. Дождаться рестарта сервиса (деплой/Manual Deploy).
- **Что проверить после:** приложение пишет/читает D1 — открыть дашборд
  (вкладка «Аналитика»), убедиться что список записей и живая поездка идут.
  `curl -s https://<app>/health` — `{"status":"ok"}`. Запрос со СТАРЫМ
  секретом к `/query` должен вернуть 401.
- **Зависимости:** у секрета нет потребителей кроме Render-сервиса.

## 2. LOGIN_PASSWORD

- **Где живёт:** env `LOGIN_PASSWORD` на Render (`sync: false` в render.yaml).
- **Как ротировать:** Render → Environment → новое значение → редеплой.
- **После:** владелец входит по новому паролю (legacy-ветка логина).
  Зарегистрированные пользователи не затронуты (их пароли — bcrypt в
  таблице `User`; при желании сменить и их — отдельная процедура).
- **Rate-limit логина** не пострадает: бакеты по IP и по паре логин+IP
  (v2.38.1/ревью F10) не зависят от значения пароля.

## 3. SESSION_SECRET

- **Где живёт:** env `SESSION_SECRET` на Render.
- **Как ротировать:** Render → Environment → новое значение → редеплой.
- **Последствия (важно, автоматической инвалидации «мягкой» нет):**
  - ВСЕ сессионные cookie становятся невалидными (HMAC-подпись) — все
    пользователи, включая владельца, перелогиниваются;
  - ВСЕ share-ссылки (`/shared/<token>`) отзываются — токены
    подписаны тем же секретом (найти F14: реестра нет, смена секрета —
    единственный полный отзыв);
  - ВСЕ производные инжест-токены `it_…` пользователей инвалидируются
    (v2.38.1/ревью F11: HMAC от apiKey с этим же секретом) — каждый
    пользователь копирует новый Push URL из /api/auth/me (вкладка
    «Поездки»), старые Push URL телефонов вернут 401 до замены.
- **После:** войти, скопировать новый Push URL в SensorLogger, проверить
  инжест одной поездкой.

## 4. API_KEY

- **Где живёт:** env `API_KEY` на Render. Полный api-скоп (legacy-канал
  владельца: Bearer для скриптов/экспорта).
- **Как ротировать:** Render → Environment → новое значение → редеплой.
- **После:** обновить все скрипты/закладки, где использовался старый
  Bearer. Per-user apiKey зарегистрированных пользователей НЕ меняются
  (живут в `User.apiKey`); их ротация — отдельно (см. ниже).
- **Ротация per-user apiKey (опционально):** значение в БД
  (`UPDATE User SET apiKey = <новый> WHERE id = …` руками/скриптом).
  Автоматически ротируется и его `it_…`-инжест-токен (HMAC от apiKey),
  пользователь копирует новый Push URL из /api/auth/me. UI-кнопки
  ротации пока нет — ручная операция.

## 5. INGEST_TOKEN

- **Где живёт:** env `INGEST_TOKEN` на Render. Глобальный канал инжеста
  владельца (SensorLogger «HTTP Push» c `?token=…`).
- **Как ротировать:** Render → Environment → новое значение → редеплой.
- **После:** **обновить Push URL в SensorLogger на телефоне владельца**
  (Настройки → HTTP Push: `https://<домен>/api/ingest?token=<новый>`).
  Без этого поездки владельца перестанут приходить — ровно так теряли
  поездки 03–07.09 при переезде на домен. Зарегистрированные
  пользователи НЕ затронуты (их канал — личные `it_…`-токены).
- **С v2.38.1 (ревью F11)** сырой per-user apiKey из query-string больше
  не принимается: если чей-то старый Push URL содержал apiKey — заменить
  на `it_…`-токен из /api/auth/me.

## 6. CRON_SECRET

- **Где живёт:** env `CRON_SECRET` на Render + env `CRON_SECRET` в
  КАЖДОМ cron-сервисе рендера (retention / alerts / backup /
  github-backup / finalize-sessions — 5 штук, все `sync: false`).
- **Как ротировать:** Render → Environment web-сервиса → новое значение;
  затем то же значение в Environment КАЖДОГО cron-сервиса (иначе кроны
  начнут получать 401 и, например, автобэкапы молча прекратятся — как в
  АУДИТ C-3). Редеплой web-сервиса.
- **После:** дождаться ближайшего срабатывания крона (кроны каждые 5 мин
  — alerts/finalize; проверить `logger` на 401), либо дернуть вручную:
  `curl -sf -X POST https://<app>/api/cron/alerts -H "Authorization: Bearer <новый>"`.

## 7. ADMIN_TOKEN

- **Где живёт:** env `ADMIN_TOKEN` на Render.
- **Как ротировать:** Render → Environment → новое значение → редеплой.
- **После:** обновить скрипты/закладки админ-операций (backup/restore/
  requeue). Backup-кроны не затронуты (ходят с CRON_SECRET).

## 8. TURSO_AUTH_TOKEN

- **Где живёт:** env `TURSO_AUTH_TOKEN` на Render (наследие миграции v2.37.0
  Turso → D1).
- **Как ротировать:** токен Turso — панель Turso → API tokens → revoke
  старый, создать новый; Render → Environment → новое значение →
  редеплой. Если Turso-аккаунт больше не используется (прод на D1) —
  просто REVOKE токен в Turso и удалить переменную из Render: живой
  JWT в xlsx = доступ к старой копии БД.
- **После:** при удалённой переменной проверить, что `DATABASE_URL` не
  указывает на libsql/Turso в проде (должен быть D1 через шлюз).

### Прочие env-секреты (тоже были/есть в env-каналах — проверить и их)

| Имя | Где | После ротации обновить |
|---|---|---|
| `TWO_GIS_API_KEY` | Render env (+ таблица `Setting`) | обе точки; `POST /api/admin/settings` |
| `GH_TOKEN` | Render env (backup-cron'ы + web) | ВСЕ cron-сервисы с GH_TOKEN + web |
| `SLACK_WEBHOOK_URL` | Render env | нигде — webhook перевыпускается в Slack |

## 9. «пазворты.xlsx» — уничтожить (F2)

1. Файл с plaintext-секретами, гуляющий по чатам, **уничтожить** на всех
   носителях/пересылках, где он есть (чаты, загрузки, облака). Все
   значения в нём после шагов 1–8 уже недействительны — но хранить
   скомпрометированные «на память» нельзя.
2. Новые значения секретов — **только** в Render Environment (или
   внешнем менеджере секретов). НИКОГДА не в файлах репозитория, чатах,
   таблицах.
3. Передача владельцу — защищённым каналом (менеджер секретов с
   одноразовой ссылкой); идеально — значение вообще не покидает
   Render-дашборд (вводит сам владелец).

## 10. Вычистка секрета из git-истории (F1)

`.env.production.local` трекается с коммита `25bd1bd`. Выполняет владелец
(или оркестратор) — от локальной копии репо, НЕ из песочницы:

```bash
# 1. Перестать трекать (файл остаётся на диске для локального next start):
git rm --cached .env.production.local
git commit -m "v2.38.1 (ревью F1): untrack .env.production.local — секрет в истории"

# 2. Вычистить из ВСЕЙ истории (перепишет коммиты):
pipx install git-filter-repo   # или: pip install git-filter-repo
git filter-repo --path .env.production.local --invert-paths

# 3. Принудительно опубликовать переписанную историю:
git push origin --force --all
git push origin --force --tags

# 4. Collaborators/клоны: свежий clone (старые клоны содержат секрет).
```

Примечания:

- `git filter-repo` удаляет remote `origin` после переписывания —
  переподключить: `git remote add origin <url>`.
- На GitHub: секрет остался в форках/кэше — GitHub Support может
  очистить кэш представлений по запросу; надёжность обеспечивает
  РОТАЦИЯ (шаги 1–8): даже найденный в старом коммите секрет бесполезен.
- Render-деплой берёт код из репо: после force-push сделать Manual
  Deploy (и убедиться, что `.env.production.local` больше не приезжает —
  при необходимости скопировать его на сервер вручную в/env Render).
- Проверка: `git log --all --full-history -- .env.production.local`
  → пусто; `git ls-files | grep env` → пусто; `scripts/check-secrets.sh`
  → `SECRETS-CHECK OK`.

## 11. Верификация после ротации (чек-лист)

```bash
# 1. Старые секреты мертвы (каждая команда должна вернуть 401/Unauthorized):
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<app>/api/ingest \
  -H "Authorization: Bearer <СТАРЫЙ INGEST_TOKEN>" -H "content-type: application/json" \
  -d '{"deviceId":"rot-check","clientId":"rot-check","points":[]}'
# старый D1_GATEWAY_SECRET к шлюзу:
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://d1-gateway.markov-saratov.workers.dev/query \
  -H "x-gateway-secret: <СТАРЫЙ>" -H "content-type: application/json" -d '{"sql":"SELECT 1"}'

# 2. Новые работают:
curl -s https://<app>/health                      # {"status":"ok",...}
curl -s https://d1-gateway.../health              # {"ok":true,...}
```

- [ ] Вход в UI (новый LOGIN_PASSWORD) — ок;
- [ ] Вкладка «Аналитика» грузится (D1-шлюз с новым секретом) — ок;
- [ ] SensorLogger владельца шлёт точки (новый INGEST_TOKEN в URL) — ок,
      `/api/admin/alerts` → `ingest_total` растёт;
- [ ] Зарегистрированные пользователи перелогинились, скопировали новые
      Push URL (`it_…`) из вкладки «Поездки»;
- [ ] Ближайший cron отработал (логи без 401); ночной бэкап создался;
- [ ] `git log --all --full-history -- .env.production.local` → пусто;
- [ ] `scripts/check-secrets.sh` → OK;
- [ ] Ответы API не содержат сырых apiKey: `curl -s
      https://<app>/api/auth/me -H "Cookie: <session>"` → `ingestToken`
      начинается с `it_`, `apiKeyPreview` — маска вида `a1b2…c3d4`.

## Ссылки

- Харденинг шлюза: `cloudflare-worker/d1-gateway.js` (вайтлист операций,
  лимит тела 2 МБ, per-IP rate-limit; env-оверрайды `GATEWAY_RATE_LIMIT_MAX`,
  `GATEWAY_MAX_BODY_BYTES`).
- Производный инжест-токен: `src/lib/token-check.ts`, `src/lib/auth.ts`
  (ревью F11).
- Проверка перед коммитом: `scripts/check-secrets.sh`.
- Контекст инцидентов: `docs/OPERATIONS.md` §C-1, `docs/CUSTOM_DOMAIN.md`.
