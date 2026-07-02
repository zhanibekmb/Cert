# Cert — что тебе нужно сделать (гайд)

Обновлено: 2026-06-30. Этот файл — пошаговый чек-лист, чтобы довести приложение
до рабочего состояния после сделанных изменений (честность стрика, заморозки,
статистика, светлая тема, RU-локализация, платежи).

---

## 0. СНАЧАЛА — БЕЗОПАСНОСТЬ (сделай прямо сейчас)

Два секрета засветились и их нужно отозвать/заменить:

1. **Supabase access-токен** (`sbp_…`), который ты прислал в чат.
   → Supabase → Account → **Access Tokens → Revoke**. Я использовал его только
   разово для деплоя, нигде не сохранял.

2. **RevenueCat ключ в `mobile/config.js`** — ты вставил `sk_…`. Это **секретный
   серверный ключ**, его НЕЛЬЗЯ класть в приложение (он управляет всем аккаунтом
   RevenueCat). 🔴 Отзови его в RevenueCat → Project → API keys и **замени на
   ПУБЛИЧНЫЕ SDK-ключи**:
   - iOS: ключ вида `appl_…` → в `REVENUECAT_IOS_KEY`
   - Android: ключ вида `goog_…` → в `REVENUECAT_ANDROID_KEY`
   (они на той же странице, раздел «App-specific keys (public)»; для iOS и Android
   ключи РАЗНЫЕ — сейчас стоит один и тот же, это неверно.)

---

## 1. Что уже сделано (контекст)

- **Supabase (прод, ref `hiydsiiuzpneykbjddsr`):** применена миграция
  `20260630000000_streak_honesty.sql` (вечный счётчик `verified_days_total`,
  `last_swept_day`, таблица `freeze_grants`); задеплоены функции `judge`
  (обновлён), `daily-sweep` (новый), `revenuecat-webhook` (новый); включены
  расширения `pg_cron` + `pg_net`.
- **Мобайл (`mobile/App.js`):** честность стрика, статистика (герои + теплокарта,
  аналитика за Pro), Pro-гейт таймлапса, покупка заморозок, светлая тема,
  RU-локализация всех основных экранов, эмодзи-«стикеры» убраны.

Осталось 3 вещи, которые требуют твоих аккаунтов/секретов: **cron, RevenueCat,
сборка приложения.** Ниже по шагам.

---

## 2. Ночной проход (cron) — УЖЕ НАСТРОЕН ✅

Cron `cert-daily-sweep` создан и крутится **каждый час** (active=true), проверено
живым вызовом: `{swept:15, reset:0, frozen:0, skipped_weekly:1}`.

**Важно про аутентификацию:** sweep защищён НЕ service-ключом, а отдельным секретом
`SWEEP_SECRET` (так надёжнее: можно ротировать service-ключ, не ломая cron; и это
устойчиво к новому формату ключей Supabase). Функция `daily-sweep` задеплоена с
`--no-verify-jwt`, секрет уже задан (`supabase secrets set SWEEP_SECRET=…`), а cron
передаёт его в заголовке.

Тебе тут делать ничего не нужно. Памятка, ЕСЛИ когда-нибудь будешь пересоздавать cron
(значение секрета — в защищённом хранилище секретов функции, при необходимости задай
новое и обнови оба места):

```sql
select cron.schedule('cert-daily-sweep', '0 * * * *', $$
  select net.http_post(
    url := 'https://hiydsiiuzpneykbjddsr.supabase.co/functions/v1/daily-sweep',
    headers := jsonb_build_object(
                 'Authorization', 'Bearer <SWEEP_SECRET>',
                 'Content-Type',  'application/json'),
    body := '{}'::jsonb
  );
$$);
```

Проверка джоба: `select jobname, schedule, active from cron.job;`

---

## 3. RevenueCat: продукты, entitlement, вебхук

### 3.1 Продукты
В RevenueCat → Products создай (id должны совпадать с кодом — см.
`mobile/config.js` и `supabase/functions/revenuecat-webhook/index.ts`):
- Расходники (consumable, доступны и free-юзерам): `freeze_pack_3`, `freeze_pack_10`
- Подписки: `cert_pro_monthly`, `cert_pro_yearly`

Эти же id заведи в App Store Connect и Google Play Console (как IAP-продукты).

### 3.2 Вебхук (сервер уже готов)
1. Придумай секрет (любая длинная случайная строка).
2. Задай его функции:
   ```
   npx supabase secrets set REVENUECAT_WEBHOOK_SECRET=<секрет> --project-ref hiydsiiuzpneykbjddsr
   ```
3. RevenueCat → Integrations → **Webhooks**:
   - URL: `https://hiydsiiuzpneykbjddsr.supabase.co/functions/v1/revenuecat-webhook`
   - Authorization header: тот же `<секрет>`
4. На клиенте RevenueCat должен идентифицировать юзера как Supabase user id —
   это уже сделано в `mobile/purchases.js` (`appUserID`).

### 3.3 Ключи в приложение
В `mobile/config.js` впиши **публичные** `appl_…` / `goog_…` (см. раздел 0).

---

## 4. Мобайл: установка и запуск

RevenueCat — нативный модуль, **в Expo Go не работает**. Нужен dev-client или
EAS-сборка.

```bash
cd mobile
npx expo install react-native-purchases      # native SDK для платежей
npm install                                   # на всякий случай подтянуть остальное
```

Запуск для разработки (нативный dev-client):
```bash
npx expo run:ios        # или: npx expo run:android  (нужен Xcode / Android Studio)
```
Либо облачная сборка:
```bash
npm i -g eas-cli
eas login
eas build --profile development --platform ios     # и/или android
```

Без платежей (быстро посмотреть UI/тему/локализацию) можно и в Expo Go:
`npx expo start` — покупки просто покажут «платежи не настроены», остальное работает.

---

## 4.5. Как протестировать Pro-функции БЕЗ реальной оплаты

Pro-функции (таймлапс, аналитика-теплокарта, ежемесячные заморозки, таймлапс в
групповых челленджах) гейтятся по `profiles.plan`. Заморозки — по `profiles.freezes`.
Чтобы проверить их на тест-аккаунте, просто выстави эти поля в БД.

1. Зарегистрируй тест-аккаунт в приложении (запомни email).
2. Supabase → **SQL Editor**:

```sql
-- сделать тест-юзера Pro + начислить 5 заморозок (по email)
update public.profiles p
set plan = 'monthly', freezes = 5
from auth.users u
where u.id = p.id and u.email = 'ТВОЙ_ТЕСТ_EMAIL';
```

3. В приложении на этом аккаунте потяни экран вниз (обновить) или перезайди —
   увидишь: таймлапс разблокирован, в Статистике появилась теплокарта/трофеи,
   в Профиле баланс заморозок = 5.
4. Вернуть обратно во Free для проверки гейтов: `set plan='free', freezes=0`.

Проверить, что вебхук платежей реально начисляет (когда настроишь RevenueCat):
сделай тестовую покупку в sandbox → в БД должна появиться строка в `freeze_grants`
и вырасти `profiles.freezes` / `plan`.

**Тест ночного прохода вручную** (не ждать час): дёрни функцию с секретом — она
вернёт `{swept, reset, frozen}`:
```bash
curl -X POST https://hiydsiiuzpneykbjddsr.supabase.co/functions/v1/daily-sweep \
  -H "Authorization: Bearer <SWEEP_SECRET>" -H "Content-Type: application/json" -d '{}'
```
Чтобы увидеть реальный сброс/заморозку: у тест-цели поставь `last_swept_day` на
позавчера и не отправляй пруф за вчера, потом вызови sweep — стрик обнулится (или
спишется заморозка, если `freezes>0`).

## 4.7. Уведомления

Две системы:

**1. Локальные напоминания (на устройстве, без сервера).** Тумблер в Настройках.
Планирует ежедневное напоминание на выбранное время + вечернее «последний шанс» в
21:00, если основное стоит раньше. Текст локализован (RU/EN) и перепланируется при
смене языка. Тебе делать ничего не нужно, кроме как включить тумблер.

**2. Push «серия под угрозой» (сервер → устройство).** Функция `risk-push` шлёт push
тем, кто к ~20:00 по своему времени НЕ доказал цель, запланированную на сегодня.
Бэкенд готов и запланирован: cron `cert-risk-push` (раз в час), проверено живым
вызовом (`{candidates:0, pushed:0}` — пока нет устройств с токеном). Чтобы заработало:
- Нужен **EAS projectId** для Expo push-токенов: выполни `eas init` в `mobile/`
  (пропишет `extra.eas.projectId` в `app.json`). Без него токен не выдаётся.
- `npx expo install expo-constants expo-notifications` (уже в зависимостях).
- Нужен **dev/EAS-build на реальном телефоне** (в Expo Go push с SDK 53+ не работает,
  и симулятор токен не выдаёт).
- При входе приложение само регистрирует токен → строка `profiles.expo_push_token`.

Проверка push вручную (после регистрации токена на устройстве): дёрни функцию —
```bash
curl -X POST https://hiydsiiuzpneykbjddsr.supabase.co/functions/v1/risk-push \
  -H "Authorization: Bearer <SWEEP_SECRET>" -H "Content-Type: application/json" -d '{}'
```
(шлёт только если у юзера сейчас ~20:00 локально и цель не выполнена; для теста можно
временно поменять `TARGET_HOUR` в `supabase/functions/risk-push/index.ts` на текущий час
и передеплоить).

## 4.8. Авторизация и ссылки

Я проверил — **код приложения и настройки Supabase уже корректны**, менять в коде ничего
не нужно:
- Клиент: `flowType: "pkce"`, `detectSessionInUrl: false`, хранилище AsyncStorage (правильно для RN).
- Supabase Auth: `site_url = cert://`; allowlist `cert://, cert://**, exp://**` (покрывает приложение и Expo Go);
  Google включён, client_id + secret заданы; email включён; `mailer_autoconfirm = true`.
- Deep links `cert://` и `cert://join?code=` зарегистрированы (`app.json`) и обрабатываются.

Поэтому если что-то «не работает», причина — во **внешних аккаунтах**, не в коде:

**1. Google — добавь redirect URI в Google Cloud Console.** Это сама частая причина
`redirect_uri_mismatch`. Google Cloud → APIs & Services → Credentials → твой OAuth client
(`502488167631-…apps.googleusercontent.com`) → **Authorized redirect URIs** должен содержать:
```
https://hiydsiiuzpneykbjddsr.supabase.co/auth/v1/callback
```
Плюс OAuth consent screen должен быть опубликован (или твой email добавлен в Test users,
пока приложение в режиме Testing).

**1b. Если OAuth-клиент удалён — создай заново.** (старый `502488167631-…` удалён, поэтому
Google-вход не работает, пока не заменишь.)

⚠️ Google переделал UI: старой страницы «OAuth consent screen» с выбором *Internal/External*
больше НЕТ. Теперь всё в разделе **Google Auth Platform**, а *External* выбирается внутри шага
**Audience**.

0. Вверху, рядом с логотипом Google Cloud, проверь что выбран **проект** (или создай новый).
1. Меню (☰) → **APIs & Services → OAuth consent screen** → откроется «Google Auth Platform».
   Если ещё не настраивал — нажми **Get started / Начать**. Мастер:
   - **App information**: название приложения + support email.
   - **Audience**: выбери **External** (для личного Gmail это единственный вариант — *Internal*
     доступен только в Google Workspace-организациях).
   - **Contact information**: твой email. Принять политику → **Create**.
2. Слева → **Clients** → **Create client** → Application type = **Web application** → имя.
3. **Authorized redirect URIs** → добавь ровно:
   ```
   https://hiydsiiuzpneykbjddsr.supabase.co/auth/v1/callback
   ```
4. **Create** → скопируй **Client ID** и **Client Secret**.
5. Если приложение в статусе *Testing*: слева → **Audience → Test users → Add users** → добавь
   свой email (иначе вход заблокируется), либо опубликуй приложение.
6. Впиши Client ID + Secret в Supabase → Authentication → Providers → **Google**, либо пришли
   мне — пропишу через API. iOS/Android-клиенты для текущего flow НЕ нужны, хватает Web-клиента.

**2. Email-ссылки — настрой свой SMTP.** Сейчас SMTP не задан → Supabase шлёт через общий
сервер, который жёстко лимитирован (~3-4 письма/час) и часто падает в спам. Из-за этого
письма сброса пароля могут не доходить. Supabase → Authentication → **SMTP Settings** →
подключи Resend / SendGrid / Postmark (любой). 
Заметь: вход по email СЕЙЧАС работает БЕЗ письма — `mailer_autoconfirm` включён, подтверждение
почты не требуется (сессия сразу). Письмо отправляется только при **сбросе пароля**.
Если захочешь обязательное подтверждение почты — выключи autoconfirm, но тогда SMTP обязателен.

**3. Тестируй на реальном устройстве / dev-build.** Deep link `cert://` открывает установленное
приложение; в Expo Go редирект приходит как `exp://…` (тоже в allowlist). Полный цикл OAuth
надёжнее всего проверять на dev/EAS-сборке.

## 4.9. Товары: сторы + RevenueCat (пошагово)

**Наши 4 товара (ID должны совпадать везде — код, RevenueCat, сторы):**
- Подписки (auto-renewable): `cert_pro_monthly`, `cert_pro_yearly`
- Расходники (consumable): `freeze_pack_3`, `freeze_pack_10`
- Entitlement в RevenueCat: **`pro`** (привязать к обеим подпискам).

Порядок: сначала товары в сторах → потом RevenueCat → потом ключи в приложение.

---

### A. App Store Connect (iOS)

Пред-условия: Apple Developer ($99), подписан Paid Applications agreement, приложение
создано (bundle `app.cert.mobile`).

1. **Подписки.** App Store Connect → твоё приложение → Monetization → **Subscriptions**:
   - Создай Subscription Group (напр. «Cert Pro»).
   - Внутри создай два продукта: **`cert_pro_monthly`** (длительность 1 месяц) и
     **`cert_pro_yearly`** (1 год). Укажи цены, отображаемое имя, описание (локализации).
2. **Расходники.** Monetization → **In-App Purchases** → тип **Consumable**: создай
   **`freeze_pack_3`** и **`freeze_pack_10`** (цены, имя, описание).
3. Заполни у каждого продукта: локализацию, review-скриншот (для подписок обязателен).
4. **App-Specific Shared Secret**: App Store Connect → App Information (или Users and
   Access → Integrations → In-App Purchase) → скопируй для RevenueCat.

### B. Google Play Console (Android)

Пред-условия: Play Console ($25 разово), приложение создано, хотя бы один build залит в
трек (Internal testing) — иначе товары не активируются.

1. **Подписки.** Monetize → Products → **Subscriptions** → создай **`cert_pro_monthly`** и
   **`cert_pro_yearly`** (каждая — отдельный продукт со своим base plan; цены, период).
2. **Расходники.** Monetize → Products → **In-app products** → создай **`freeze_pack_3`**,
   **`freeze_pack_10`**, тип managed/consumable (цены, описание).
3. **Service account для RevenueCat**: Play Console → Setup → API access → создай/свяжи
   service account, дай права на финансы/подписки, скачай **JSON-ключ**. Он нужен
   RevenueCat, чтобы валидировать покупки и получать уведомления.

⚠️ **Нюанс Android-подписок:** на Google Play подписка = продукт + base plan, и RevenueCat
отдаёт их идентификатор как `подписка:basePlan`, что НЕ совпадает с плоским
`cert_pro_monthly`. Из-за этого текущий код (`getProducts([id])`) на Android для подписок
может не найти товар по точному ID. **Решение — Offerings** (см. пункт D2 и примечание в
конце). Расходники (freeze packs) по плоскому ID работают на обеих платформах.

### C. RevenueCat

1. Project → **Apps**: добавь iOS-app (bundle `app.cert.mobile`, вставь **App-Specific
   Shared Secret** из A4) и Android-app (package `app.cert.mobile`, загрузи **service
   account JSON** из B3).
2. **Products**: импортируй / добавь все 4 товара по их ID (`cert_pro_monthly`,
   `cert_pro_yearly`, `freeze_pack_3`, `freeze_pack_10`).
3. **Entitlements**: создай **`pro`** и привяжи к `cert_pro_monthly` + `cert_pro_yearly`.
   (Заморозки — расходники, к entitlement НЕ привязываются.)
4. **Offerings** (рекомендуется): создай offering `default` с пакетами Monthly / Annual,
   привязанными к подпискам. Так товары работают одинаково на iOS и Android.
5. **API keys** → «Public app-specific»: `appl_…` → `REVENUECAT_IOS_KEY`, `goog_…` →
   `REVENUECAT_ANDROID_KEY` в `mobile/config.js`.
6. **Webhook** (функция уже задеплоена): Integrations → Webhooks → URL
   `https://hiydsiiuzpneykbjddsr.supabase.co/functions/v1/revenuecat-webhook`, заголовок
   Authorization = секрет, и задай тот же секрет:
   `npx supabase secrets set REVENUECAT_WEBHOOK_SECRET=<секрет> --project-ref hiydsiiuzpneykbjddsr`.

### D. Проверка

- Sandbox: iOS — добавь Sandbox-тестера в App Store Connect, войди им на устройстве;
  Android — добавь license testers в Play Console, ставь build из Internal testing.
- Купи → в приложении Paywall покажет цены; после покупки в БД появится строка в
  `freeze_grants` и/или обновится `profiles.plan` / `profiles.freezes` (через вебхук).

### Примечание про код и Offerings

Сейчас Paywall тянет товары через `getProducts([плоские ID])`. Это чисто работает для
**iOS** и для **расходников на обеих платформах**. Для **Android-подписок** правильнее
перевести Paywall на **`getOfferings()`** (идентификаторы пакетов store-агностичны). Скажи —
переведу Paywall на Offerings, тогда одинаково заработает и на Android.

## 5. Чек-лист проверки на телефоне

- [ ] Вход (email + Google), регистрация.
- [ ] Создать цель → выбрать «📷 фото» (таймлапс под замком, если не Pro).
- [ ] Отправить пруф → ЗАСЧИТАНО → стрик +1; повторный сабмит в тот же день
      говорит «уже выполнил сегодня» (нет двойного счёта).
- [ ] Отказ при оставшихся попытках НЕ обнуляет стрик; после исчерпания попыток —
      апелляция.
- [ ] Статистика: «дней засчитано» и «лучшая серия» растут; теплокарта/трофеи —
      только у Pro.
- [ ] Профиль: баланс заморозок, кнопка «Купить заморозки», «Перейти на Pro».
- [ ] Настройки: переключение **темы** (Системная/Тёмная/Светлая) и **языка**
      (Системный/EN/RU) меняет весь интерфейс сразу.
- [ ] Инвайт-ссылка challenge открывает приложение и подставляет код.
- [ ] (После ночного прохода) пропусти день без заморозки → стрик обнулился;
      с заморозкой → день помечен «заморожен», стрик цел.

---

## 6. Запуск в App Store — пошагово (iOS)

✅ **Sign in with Apple — ДОБАВЛЕН** (Apple правило 4.8 требует его раз есть Google).
Сделано: кнопка на экране входа (iOS), `signInWithIdToken` → Supabase, провайдер Apple
включён в Supabase (client_id = `app.cert.mobile`), `usesAppleSignIn: true` + плагин в
`app.json`. Остаётся только: при production-сборке EAS сам включит capability «Sign in
with Apple» в Apple Developer App ID (нужен Apple-аккаунт). Проверить кнопку можно на
iOS dev-build.

**Шаг 0. Аккаунт.** Оформи Apple Developer Program ($99/год) на developer.apple.com.

**Шаг 1. App Store Connect → создать приложение.** Apps → «+» → New App: платформа iOS,
имя «Cert», язык, bundle ID `app.cert.mobile`, SKU (любой). 

**Шаг 2. Соглашения.** Agreements, Tax, and Banking → подпиши **Paid Applications**
agreement + заполни налоги/банк. Без этого IAP не продаются.

**Шаг 3. IAP-продукты** (те же ID, что в коде/RevenueCat). В App Store Connect →
Features:
- Consumable: `freeze_pack_3`, `freeze_pack_10` (цены, локализации).
- Auto-renewable subscriptions: `cert_pro_monthly`, `cert_pro_yearly` (в одной
  Subscription Group).

**Шаг 4. RevenueCat.** Project → App Store: вставь app-specific shared secret (из ASC).
Заведи те же продукты; создай entitlement `pro` и привяжи к подпискам; создай Offering.
Публичный SDK-ключ `appl_…` → `mobile/config.js`. Webhook (функция уже задеплоена):
URL `…/functions/v1/revenuecat-webhook`, заголовок Authorization = `REVENUECAT_WEBHOOK_SECRET`,
тот же секрет задай: `npx supabase secrets set REVENUECAT_WEBHOOK_SECRET=<значение>`.

**Шаг 5. Метаданные и иконки.**
- `app.json`: иконка 1024×1024 без альфа-канала, splash, `version`, `ios.buildNumber`.
- В ASC: скриншоты (минимум 6.7″ и 6.5″ iPhone), описание, ключевые слова, категория,
  возрастной рейтинг.
- **Privacy Policy URL** и **Support URL** (Apple требует) — захостить `privacy.html` /
  `terms.html` с лендинга, дать ссылки.
- **App Privacy** опросник: укажи собираемые данные (email, фото, геолокация, покупки).

**Шаг 6. Сборка и заливка (с Windows через EAS).**
```bash
cd mobile
eas build --profile production --platform ios     # EAS сам подпишет (Apple-аккаунт)
eas submit --profile production --platform ios     # зальёт в App Store Connect / TestFlight
```

**Шаг 7. Демо-аккаунт для ревью.** Вход обязателен → в App Review Information дай
тестовый email+пароль (создай заранее), иначе ревьюер не зайдёт и отклонит.

**Шаг 8. Submit for Review.** Привяжи собранный build к версии, прикрепи IAP-продукты
(в первый раз они проходят ревью вместе с приложением) → Submit. Ревью ~1–3 дня.
Частые отказы: нет Sign in with Apple (см. блокер), не работает IAP, нет демо-аккаунта,
нет privacy policy.

**Google Play (параллельно, проще):** Play Console ($25 разово, без Sign in with Apple),
создать приложение + те же IAP, `eas build/submit -p android`. Sign in with Apple там не
требуется.

---

## 7. Где что лежит (шпаргалка)

| Что | Файл |
|-----|------|
| Ночной проход (сброс/заморозка) | `supabase/functions/daily-sweep/index.ts` |
| Судья (пруф → вердикт) | `supabase/functions/judge/index.ts` |
| Вебхук платежей | `supabase/functions/revenuecat-webhook/index.ts` |
| Миграция честности | `supabase/migrations/20260630000000_streak_honesty.sql` |
| Клиент платежей | `mobile/purchases.js` |
| Переводы (EN→RU) | `mobile/lib/i18n.js` — добавить строку = одна пара "англ":"рус" |
| Тема (палитры) | `mobile/App.js` (DARK/LIGHT вверху) |
| Ключи | `mobile/config.js` |
| Локальные напоминания | `mobile/lib/reminders.js` |
| Регистрация push-токена | `mobile/lib/push.js` |
| Push «серия под угрозой» | `supabase/functions/risk-push/index.ts` |

### Про перевод
Любая строка переводится добавлением одной пары в словарь `RU` в
`mobile/lib/i18n.js`. Если перевода нет — показывается английский (приложение не
ломается). Бренд-надписи на шэр-картинке (CERT, тэглайн) намеренно оставлены как
есть. Если увидишь английский текст где-то ещё — пришли строку, добавлю.
