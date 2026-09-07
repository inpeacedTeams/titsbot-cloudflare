# TitsBot — Cloudflare Workers + Supabase PostgreSQL

Полный серверный порт проекта из `TitsBot-D-Tier.zip`: Telegram-бот, Mini App, Chat Test и три MT-попытки, неизменяемый итоговый D-Tier. Бот **сам вызывает `setMyCommands` и `setWebhook`** после настройки окружения. Вручную `/setcommands` вводить не нужно.

## Архитектура

```text
Telegram / Mini App → Cloudflare Worker → Hyperdrive → Supabase PostgreSQL
                            ↕
                   Durable Object на группу
                   alarms + Cron recovery
```

В PostgreSQL находятся пользователи, попытки, сообщения, результаты, сессии и очередь заданий. SQLite Durable Objects используется только инфраструктурой Cloudflare для ID группы и будильника — это НЕ база результатов и не замена Supabase. Длительные HTTP-запросы к LLM выполняются вне PostgreSQL-транзакций и не блокируют поток MT-событий.

## Что сохранено

- `/getdchat`: один 60-секундный Chat Test на пользователя в каждой группе; одна активная chat-сессия на группу.
- `/getdmt`: персональная Mini App, три попытки по 30 секунд, отсчёт 3 секунды; лучший Score определяет MT D.
- События ввода передаются пакетами; повтор запроса идемпотентен. Вставка, неподдерживаемый ввод, просрочка или закрытие расходуют начатую попытку.
- WPM, consistency, diversity, точность ввода и D считаются сервером. LLM оценивает только смысл Chat Test.
- До пяти завершивших калибровку участников — абсолютные границы; затем percentile/midrank. Исторические оценки не пересчитываются.
- Final D = (Chat D + MT D) / 2, включая половинные уровни. Триггеры БД защищают исходные результаты от изменения и удаления через роль приложения.
- Теги обычным участникам через `setChatMemberTag`, без повышения прав. Ошибки назначения повторяются; успешные теги сверяются примерно раз в час.
- Telegram initData проверяется серверным HMAC; ссылка привязана к пользователю и группе. Секреты не поступают в браузер.

**Изменение Chat Test:** вместо редактируемого отсчёта 3–2–1 отправляется одно сообщение GO. 60 секунд отсчитываются от даты этого сообщения Telegram. В Mini App отсчёт сохранён. Сбор контекста чужих сообщений выключен. Перенос старой SQLite-базы не выполняется автоматически: установка ниже создаёт новую базу калибровок.

## 0. Что понадобится

- Репозиторий `inpeacedTeams/titsbot-cloudflare` и доступ к нему.
- Node.js 22+ (лучше LTS), Git, аккаунт Cloudflare с Workers, Durable Objects и Hyperdrive.
- Supabase-проект с PostgreSQL.
- Telegram-бот из @BotFather, его токен и username без `@`.
- Группа, ID группы, право бота «Управление тегами».
- OpenAI-совместимый провайдер с `chat/completions` и strict `json_schema`: URL, ключ, имя поддерживаемой модели. Модель намеренно не выбрана за вас.

Для реальной нагрузки рекомендуется Workers Paid: проверка дубликатов текста, alarms и количество запросов ограничиваются тарифами. Supabase, Cloudflare и LLM могут тарифицироваться отдельно. Это не обещание бесплатной эксплуатации.

## 1. Скачать проект

Авторизуйте Git на своём компьютере, затем:

```bash
git clone https://github.com/inpeacedTeams/titsbot-cloudflare.git
cd titsbot-cloudflare
npm install
npm run check
npm test
```

После первой установки сохраните `package-lock.json` в Git. Он фиксирует выбранные версии; дальнейшие установки можно выполнять через `npm ci`. В этой поставке lockfile не сгенерирован: среда подготовки не имела доступа к npm registry.

## 2. Создать PostgreSQL в Supabase

1. Откройте https://supabase.com/dashboard → **New project**. Задайте имя, регион и пароль владельца БД. Дождитесь готовности.
2. Откройте **SQL Editor → New query**.
3. Вставьте **весь** файл `supabase/migrations/001_initial.sql` и нажмите **Run**. Миграция выполняется один раз. Не запускайте SQLite-схему из старого архива.
4. Откройте `scripts/create-db-role.sql`, замените пароль-заглушку длинным случайным паролем и выполните в SQL Editor. Не сохраняйте настоящие пароли в Git.
5. В настройках API не добавляйте схему `titsbot` в exposed schemas. Браузеру не нужны ни anon key, ни service_role key.

Создаётся отдельная роль `titsbot_app` без superuser/BYPASSRLS/владения схемой. Доступ к таблицам разрешён только ей RLS-политиками и владельцу БД. Таблицы видны в Supabase Table Editor после выбора схемы `titsbot`.

## 3. Соединить Hyperdrive и Supabase

1. Supabase → **Connect → Direct connection**. Возьмите hostname вида `db.PROJECT_REF.supabase.co`, порт `5432`, база `postgres`.
2. Cloudflare Dashboard → **Hyperdrive → Create configuration**.
3. Имя: `titsbot-postgres`. Укажите host/port/database из предыдущего шага, пользователя **titsbot_app** и пароль этой роли, не пароль владельца.
4. Включите защищённое соединение с исходной БД. **Отключите caching** у Hyperdrive: кэширование SELECT недопустимо для таймеров, сессий и числа попыток.
5. Сохраните конфигурацию и скопируйте её ID в `wrangler.jsonc`, поле `hyperdrive[0].id` вместо 32 нулей.

Cloudflare рекомендует Direct connection, а не Supabase transaction/session pooler: пул соединений уже делает Hyperdrive. При проблемах проверьте пароль роли, регион, hostname и ограничения сети Supabase; не отключайте TLS ради обхода ошибки.

Документация: https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/

## 4. Настроить Telegram и группу

1. Если бот ещё не создан: @BotFather → `/newbot`. Для существующего бота используйте его текущий токен.
2. Добавьте бота в **тестовую** группу, назначьте администратором и включите **«Управление тегами»**. Боту не нужны права повышать участников.
3. В настройках группы запретите обычным участникам изменять свои теги. Если настройка наследуется от закрепления сообщений, отключите соответствующее разрешение.
4. Для Chat Test бот должен видеть обычные сообщения. Администратор-бот их получает; проверьте это в тестовой группе. Если бот не администратор, одного отключения privacy недостаточно для выдачи тегов.
5. Узнайте ID группы. Для supergroup можно открыть ссылку на сообщение вида `t.me/c/1234567890/123`: ID такой группы — `-1001234567890`. Это правило не относится к публичным username-ссылкам и обычным группам.
6. Тестировать нужно **обычным участником**, не администратором группы. Административный статус бот не меняет.

**Не используйте токен этого же бота одновременно в старом Python polling-процессе и Workers.** Остановите прежний бот перед активацией новой версии. Автонастройка заменит старый webhook на адрес этого Worker; очередь Telegram не очищается.

## 5. Заполнить wrangler.jsonc

Замените значения `vars`:

| Настройка | Значение |
| --- | --- |
| `BOT_USERNAME` | Username без `@`, совпадает с токеном |
| `ALLOWED_CHAT_IDS` | ID группы или несколько через запятую, максимум 32 |
| `PUBLIC_URL` | HTTPS origin Worker, без пути/query, например `https://titsbot-cloudflare.myaccount.workers.dev` |
| `LLM_BASE_URL` | Базовый API URL с `/v1`, если он нужен провайдеру |
| `LLM_MODEL` | Модель провайдера с поддержкой strict JSON schema |

В `hyperdrive[0].id` вставьте настоящий ID. Не меняйте имя класса Durable Object и уже применённые migration tags при обычном обновлении. Не используйте `DATABASE_URL` как production secret, если хотите подключаться через Hyperdrive: локальная переменная имеет приоритет.

## 6. Войти в Cloudflare, развернуть и добавить секреты

```bash
npx wrangler login
npm run build
npm run deploy
```

Первое развёртывание до добавления секретов может отдавать `503` на `/readyz`; это нормально. Worker не начинает тесты с неполной конфигурацией. Команда deploy покажет адрес — проверьте, что он совпадает с `PUBLIC_URL`, при необходимости поправьте конфигурацию и разверните повторно.

Добавьте три секрета интерактивно:

```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put LLM_API_KEY
```

- `BOT_TOKEN` — токен из @BotFather.
- `WEBHOOK_SECRET` — отдельная случайная строка 32–256 символов, только буквы, цифры, `_` или `-`. Например, создайте 64 hex-символа командой ниже. Сохраните значение безопасно.
- `LLM_API_KEY` — ключ провайдера.

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

После всех настроек:

```bash
npm run deploy
```

Не публикуйте секреты в `wrangler.jsonc`, README, Issues, чатах или скриншотах. Если секрет попал в Git, удаление файла недостаточно — сначала отзовите и замените секрет.

## 7. Команды и webhook установятся автоматически

Cron раз в минуту проверяет конфигурацию. При первой успешной проверке бот:

1. Проверяет токен через `getMe` и соответствие username.
2. Вызывает `setMyCommands` для `/getdchat` и `/getdmt`.
3. Вызывает `setWebhook` с `/telegram/webhook` и секретом заголовка.
4. Проверяет webhook и записывает fingerprint настройки в PostgreSQL.

Если это уже настроено — лишние вызовы не выполняются. Изменение настроек вызывает повторную регистрацию; раз в сутки конфигурация сверяется повторно. Изменения Cloudflare Cron могут распространяться до 15 минут.

**Для немедленной регистрации:** создайте локальный `.dev.vars` (он в `.gitignore`) с двумя строками:

```dotenv
PUBLIC_URL=https://YOUR-WORKER.workers.dev
WEBHOOK_SECRET=YOUR_SAVED_WEBHOOK_SECRET
```

И выполните:

```bash
npm run setup
```

Скрипт обращается к защищённому `/admin/setup`; токен Telegram копировать в файл не требуется. Успех: JSON с `ok: true`, username, webhook и списком команд. Ручной `/setcommands` не нужен. Если ранее у бота были отдельные команды для конкретного чата/языка, Telegram может показывать их вместо default scope — удалите прежние переопределения.

## 8. Включить Main Mini App — один ручной шаг в BotFather

@BotFather → `/mybots` → ваш бот → **Bot Settings → Configure Mini App / Main Mini App**. Включите приложение и укажите `PUBLIC_URL`.

Это не `/setcommands`: настройка Main Mini App нужна для ссылок `t.me/BOT?startapp=TOKEN` и не настраивается в этом проекте через Bot API. Тест открывайте по персональной кнопке от `/getdmt` в группе, а не просто по адресу Worker или кнопке профиля без токена.

Документация: https://core.telegram.org/bots/webapps

## 9. Проверить запуск

1. `https://YOUR-WORKER/healthz` → `ok: true`: Worker отвечает.
2. `https://YOUR-WORKER/readyz` → `ok: true, database: true`: конфигурация и миграция доступны. Это не проверка баланса LLM или прав Telegram.
3. `npm run setup` → `ok: true`: команды и webhook зарегистрированы.
4. Из аккаунта обычного участника в разрешённой группе: `/getdchat`. Дождитесь GO, напишите несколько осмысленных сообщений. Через 60 секунд + 5 секунд grace бот поставит анализ в очередь.
5. `/getdmt` → персональная кнопка → три попытки. Проверяйте с клавиатурой без IME/автозамены; неподдерживаемый ввод расходует попытку.
6. В Supabase проверьте `users`, `chat_tests`, `mt_attempts`, `outbox`. Должен появиться итоговый D и `tag_status = ASSIGNED`.
7. Перезапуск Mini App не должен позволять четвёртую попытку или новый Chat Test.

Логи:

```bash
npm run logs
```

Приложение намеренно не логирует токены, initData, тексты сообщений и raw HTTP-ошибки с секретными URL. Cloudflare access-логи всё равно могут содержать метаданные запросов — настройте их доступ и срок хранения.

## 10. Обновление, резервные копии и диагностика

- Обновление: `git pull`, `npm install` (или `npm ci` с lockfile), `npm test`, `npm run deploy`.
- Резервная копия — средствами Supabase/PITR либо `pg_dump` всей схемы `titsbot`, включая функции/триггеры. Перед восстановлением остановите приём новых тестов. Не ограничивайтесь CSV-экспортом таблицы users.
- Новая установка не импортирует прошлые калибровки из SQLite. Если они есть, сначала нужен отдельный перенос данных; иначе пользователи получат чистую историю.
- Подробности ограничений и диагностики: [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Тесты и статус проверки

```bash
npm run check
npm test
# Только НОВАЯ одноразовая PostgreSQL-база. Не production!
# Установите TEST_DATABASE_URL в окружении, затем:
npm run test:db
npm run build
```

GitHub Actions запускает syntax/unit tests, интеграционные тесты с PostgreSQL 17 и Wrangler dry-run. CI не развёртывает production и не получает пользовательские секреты.

При подготовке локально выполнены syntax/unit проверки и проверка bundling через esbuild с внешним `pg`. Реальные Telegram, Supabase, Hyperdrive и Workers не подключались: production smoke test обязателен после настройки. Интеграционные тесты PostgreSQL включены для CI, но локально не запускались — PostgreSQL и доступ к npm registry отсутствовали.
