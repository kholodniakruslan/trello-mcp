import { loadConfig } from "./config.js";

/**
 * Language of the messages the server shows to the user (connection instructions, progress log, callback page).
 * Priority:
 *   1. TRELLO_LANG env / "lang" in config.json      (explicitly pinned by the user)
 *   2. the `lang` argument the assistant passes     (language the user is writing in; remembered for the session)
 *   3. the system language (LC_ALL, LC_MESSAGES, LANG, then the OS locale)
 *   4. English
 * Languages without a dictionary here fall back to English (the assistant then relays the message in the user's language).
 * Tool descriptions are always English: they are read by the model, not by the user.
 */
export type Lang = "en" | "ru" | "uk";
export const SUPPORTED: readonly Lang[] = ["en", "ru", "uk"];

/** "ru-RU", "uk_UA.UTF-8", "RU" -> "ru"; garbage / C / POSIX -> undefined. */
function base(code?: string): string | undefined {
  if (!code) return undefined;
  const m = /^([a-z]{2,3})(?:[-_.@]|$)/i.exec(code.trim());
  return m ? m[1].toLowerCase() : undefined;
}
const toSupported = (code: string): Lang => (SUPPORTED as readonly string[]).includes(code) ? (code as Lang) : "en";

export function systemLang(env: NodeJS.ProcessEnv = process.env): Lang {
  for (const v of [env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const b = base(v);
    if (b) return toSupported(b);
  }
  try {
    const b = base(Intl.DateTimeFormat().resolvedOptions().locale);
    if (b) return toSupported(b);
  } catch {}
  return "en";
}

let asked: Lang | undefined;
/** Remember the language the user is writing in (ignored if empty/garbage). */
export function setAskedLang(code?: string): void {
  const b = base(code);
  if (b) asked = toSupported(b);
}
export function resetAskedLang(): void { asked = undefined; }

export function currentLang(): Lang {
  const pinned = base(loadConfig().lang);
  if (pinned) return toSupported(pinned);
  return asked ?? systemLang();
}

type V = Record<string, string | number | boolean | undefined>;
type Entry = (v: V) => string;
const lines = (...l: string[]) => l.join("\n");

const en = {
  apiKeyMissing: (v: V) => lines(
    "Trello API key is missing. This is the one step that cannot be automated (it needs your Trello account):",
    "  1. You need a Trello Workspace. If you have none: \"Create\" → \"Create Workspace\".",
    "  2. Open https://trello.com/power-ups/admin/new → \"My app does not use Power-Up capabilities\" →",
    "     fill in the name, workspace, email, author → \"Create\".",
    "  3. In the app menu: \"Trello authorization\" → \"Create a new API key\" → \"Generate API key\".",
    `  4. In \"Allowed origins\" add http://localhost:${v.port} (needed for the automatic mode).`,
    `  5. Copy the \"API key\" (32 characters) and save it as env var TRELLO_API_KEY or in ${v.cfg} → {"apiKey":"..."}.`,
    "The secret (64 characters) is not needed by the server; do not share it with anyone.",
  ),
  manualInstructions: (v: V) => lines(
    "MANUAL CONNECTION. What to do:",
    `  1. Open this in a browser where you are signed in to Trello: ${v.url}`,
    "  2. Check that your own app (your Power-Up's name) is asking for access, then click \"Allow\".",
    "  3. Trello shows a long token (about 76 characters). Copy it.",
    '  4. Call trello_connect with {"mode":"manual","token":"<token>"}.',
    "The server checks the token with Trello, saves it to the config and confirms your username.",
    `The token is stored only locally: ${v.cfg} (mode 600). To revoke access: trello.com → Account → Settings → Applications.`,
  ),
  choice: (v: V) => lines(
    "Trello is not connected yet. Choose how to connect and call trello_connect:",
    '  • {"mode":"auto"}   — automatic: the server opens the browser itself, you only click "Allow".',
    '  • {"mode":"manual"} — manual: you get step-by-step instructions and paste the token yourself.',
    `To skip this choice, set a default mode: TRELLO_AUTH_MODE=auto|manual or "authMode" in ${v.cfg}.`,
    "Details and current status: trello_status.",
  ),
  autoStart: () => "Automatic connection to Trello.",
  step1: () => "Step 1/6: API key found.",
  step2: (v) => `Step 2/6: local token receiver started on http://localhost:${v.port}.`,
  step3open: (v) => `Step 3/6: opening the browser with the Trello consent page. Click "Allow". If no window opened, open it manually: ${v.url}`,
  step3wait: () => "Step 3/6: waiting for your confirmation (up to 3 minutes)…",
  step4: () => "Step 4/6: the browser returned the token to the local address.",
  step5: () => "Step 5/6: checking the token with Trello…",
  step6: (v) => `Step 6/6: done. Connected user "${v.user}", token saved to ${v.cfg}.`,
  manualVerifying: () => "Manual connection: checking the token you sent with Trello…",
  manualDone: (v) => `Done. Connected user "${v.user}", token saved to ${v.cfg}.`,
  tokenRejected: (v) => `Trello rejected the token (HTTP ${v.status}): ${v.body}`,
  timeout: () => "Timed out (3 min): no confirmation received. Call trello_connect again.",
  portBusy: (v) => `Cannot listen on port ${v.port}: ${v.msg}. Set another one via TRELLO_AUTH_PORT or use the manual mode.`,
  tabsOther: () => "Closing the tab: automatic closing is supported on macOS only. The page will try to close itself; otherwise close the tab manually.",
  tabsMac: (v) => `Closing the connection tab (localhost:${v.port}) in running browsers: ${v.closed ? "done" : "nothing found or no permission to control the browser"}.`,
  pageConnecting: () => "Connecting Trello…",
  pageDone: () => "✅ Trello connected. This tab will close itself.",
  alreadyConnected: () => "Trello is already connected. Pass force=true to reconnect.",
  statusModeUnset: () => "not set (you will be asked to choose)",
  statusHint: () => 'Call trello_connect with {"mode":"auto"} or {"mode":"manual"}.',
} satisfies Record<string, Entry>;

export type Key = keyof typeof en;

const ru: Record<Key, Entry> = {
  apiKeyMissing: (v) => lines(
    "Нет API-ключа Trello. Это единственный шаг, который нельзя автоматизировать (нужен ваш аккаунт Trello):",
    "  1. В Trello должна быть рабочая область (Workspace). Если её нет, создайте: «Создать» → «Создать рабочую область».",
    "  2. Откройте https://trello.com/power-ups/admin/new → «Мое приложение не использует возможности улучшения» →",
    "     заполните название, рабочую область, email, автора → «Создать».",
    "  3. В меню приложения: «Авторизация в Trello» → «Создать новый API-ключ» → «Сгенерировать API-ключ».",
    `  4. В поле «Одобренные ресурсы» добавьте http://localhost:${v.port} (нужно для автоматического режима).`,
    `  5. Скопируйте «Ключ API» (32 символа) и сохраните: переменная окружения TRELLO_API_KEY или файл ${v.cfg} → {"apiKey":"..."}.`,
    "Секретный ключ (64 символа) серверу не нужен, никому его не показывайте.",
  ),
  manualInstructions: (v) => lines(
    "РУЧНОЕ ПОДКЛЮЧЕНИЕ. Что нужно сделать:",
    `  1. Откройте в браузере, где вы вошли в Trello: ${v.url}`,
    "  2. Проверьте, что запрашивает доступ ваше приложение (название вашего Power-Up), и нажмите «Разрешить» (Allow).",
    "  3. Trello покажет длинный токен (строка из ~76 символов). Скопируйте его.",
    '  4. Вызовите trello_connect с параметрами {"mode":"manual","token":"<токен>"}.',
    "Сервер проверит токен запросом к Trello, сохранит его в конфиг и подтвердит имя пользователя.",
    `Токен хранится только локально: ${v.cfg} (права 600). Отозвать доступ: trello.com → Аккаунт → Настройки → Приложения.`,
  ),
  choice: (v) => lines(
    "Trello ещё не подключён. Выберите способ подключения и вызовите trello_connect:",
    '  • {"mode":"auto"}   — автоматически: сервер сам откроет браузер, вам останется нажать «Разрешить».',
    '  • {"mode":"manual"} — вручную: вы получите пошаговую инструкцию и вставите токен сами.',
    `Чтобы не выбирать каждый раз, задайте режим по умолчанию: TRELLO_AUTH_MODE=auto|manual или "authMode" в ${v.cfg}.`,
    "Подробности и текущий статус: trello_status.",
  ),
  autoStart: () => "Автоматическое подключение к Trello.",
  step1: () => "Шаг 1/6: API-ключ найден.",
  step2: (v) => `Шаг 2/6: локальный приёмник токена запущен на http://localhost:${v.port}.`,
  step3open: (v) => `Шаг 3/6: открываю браузер со страницей согласия Trello. Нажмите «Разрешить». Если окно не открылось, откройте вручную: ${v.url}`,
  step3wait: () => "Шаг 3/6: жду подтверждения (до 3 минут)…",
  step4: () => "Шаг 4/6: браузер вернул токен на локальный адрес.",
  step5: () => "Шаг 5/6: проверяю токен запросом к Trello…",
  step6: (v) => `Шаг 6/6: готово. Подключён пользователь «${v.user}», токен сохранён в ${v.cfg}.`,
  manualVerifying: () => "Ручное подключение: проверяю присланный токен запросом к Trello…",
  manualDone: (v) => `Готово. Подключён пользователь «${v.user}», токен сохранён в ${v.cfg}.`,
  tokenRejected: (v) => `Trello отклонил токен (HTTP ${v.status}): ${v.body}`,
  timeout: () => "Время ожидания (3 мин) вышло: подтверждение не получено. Повторите trello_connect.",
  portBusy: (v) => `Не удалось занять порт ${v.port}: ${v.msg}. Задайте другой через TRELLO_AUTH_PORT или используйте ручной режим.`,
  tabsOther: () => "Закрытие вкладки: автоматически поддерживается только на macOS. Страница попробует закрыться сама, иначе закройте вкладку вручную.",
  tabsMac: (v) => `Закрываю вкладку подключения (localhost:${v.port}) в запущенных браузерах: ${v.closed ? "готово" : "ничего не найдено или нет разрешения на управление браузером"}.`,
  pageConnecting: () => "Подключаем Trello…",
  pageDone: () => "✅ Trello подключён. Вкладка закроется сама.",
  alreadyConnected: () => "Trello уже подключён. Для переподключения передайте force=true.",
  statusModeUnset: () => "не задан (вам предложат выбрать)",
  statusHint: () => 'Вызовите trello_connect с {"mode":"auto"} или {"mode":"manual"}.',
};

const uk: Record<Key, Entry> = {
  apiKeyMissing: (v) => lines(
    "Немає API-ключа Trello. Це єдиний крок, який не можна автоматизувати (потрібен ваш акаунт Trello):",
    "  1. У Trello має бути робочий простір (Workspace). Якщо його немає, створіть: «Створити» → «Створити робочий простір».",
    "  2. Відкрийте https://trello.com/power-ups/admin/new → «Мій додаток не використовує можливості вдосконалення» →",
    "     заповніть назву, робочий простір, email, автора → «Створити».",
    "  3. У меню додатка: «Авторизація в Trello» → «Створити новий API-ключ» → «Згенерувати API-ключ».",
    `  4. У полі «Схвалені ресурси» додайте http://localhost:${v.port} (потрібно для автоматичного режиму).`,
    `  5. Скопіюйте «Ключ API» (32 символи) і збережіть: змінна середовища TRELLO_API_KEY або файл ${v.cfg} → {"apiKey":"..."}.`,
    "Секретний ключ (64 символи) серверу не потрібен, нікому його не показуйте.",
  ),
  manualInstructions: (v) => lines(
    "РУЧНЕ ПІДКЛЮЧЕННЯ. Що потрібно зробити:",
    `  1. Відкрийте в браузері, де ви увійшли в Trello: ${v.url}`,
    "  2. Переконайтеся, що доступ просить ваш додаток (назва вашого Power-Up), і натисніть «Дозволити» (Allow).",
    "  3. Trello покаже довгий токен (рядок із ~76 символів). Скопіюйте його.",
    '  4. Викличте trello_connect з параметрами {"mode":"manual","token":"<токен>"}.',
    "Сервер перевірить токен запитом до Trello, збереже його в конфіг і підтвердить ім'я користувача.",
    `Токен зберігається лише локально: ${v.cfg} (права 600). Відкликати доступ: trello.com → Акаунт → Налаштування → Додатки.`,
  ),
  choice: (v) => lines(
    "Trello ще не підключено. Оберіть спосіб підключення і викличте trello_connect:",
    '  • {"mode":"auto"}   — автоматично: сервер сам відкриє браузер, вам залишиться натиснути «Дозволити».',
    '  • {"mode":"manual"} — вручну: ви отримаєте покрокову інструкцію і вставите токен самі.',
    `Щоб не обирати щоразу, задайте режим за замовчуванням: TRELLO_AUTH_MODE=auto|manual або "authMode" у ${v.cfg}.`,
    "Подробиці та поточний статус: trello_status.",
  ),
  autoStart: () => "Автоматичне підключення до Trello.",
  step1: () => "Крок 1/6: API-ключ знайдено.",
  step2: (v) => `Крок 2/6: локальний приймач токена запущено на http://localhost:${v.port}.`,
  step3open: (v) => `Крок 3/6: відкриваю браузер зі сторінкою згоди Trello. Натисніть «Дозволити». Якщо вікно не відкрилося, відкрийте вручну: ${v.url}`,
  step3wait: () => "Крок 3/6: чекаю підтвердження (до 3 хвилин)…",
  step4: () => "Крок 4/6: браузер повернув токен на локальну адресу.",
  step5: () => "Крок 5/6: перевіряю токен запитом до Trello…",
  step6: (v) => `Крок 6/6: готово. Підключено користувача «${v.user}», токен збережено в ${v.cfg}.`,
  manualVerifying: () => "Ручне підключення: перевіряю надісланий токен запитом до Trello…",
  manualDone: (v) => `Готово. Підключено користувача «${v.user}», токен збережено в ${v.cfg}.`,
  tokenRejected: (v) => `Trello відхилив токен (HTTP ${v.status}): ${v.body}`,
  timeout: () => "Час очікування (3 хв) вичерпано: підтвердження не отримано. Повторіть trello_connect.",
  portBusy: (v) => `Не вдалося зайняти порт ${v.port}: ${v.msg}. Задайте інший через TRELLO_AUTH_PORT або скористайтеся ручним режимом.`,
  tabsOther: () => "Закриття вкладки: автоматично підтримується лише на macOS. Сторінка спробує закритися сама, інакше закрийте вкладку вручну.",
  tabsMac: (v) => `Закриваю вкладку підключення (localhost:${v.port}) у запущених браузерах: ${v.closed ? "готово" : "нічого не знайдено або немає дозволу керувати браузером"}.`,
  pageConnecting: () => "Підключаємо Trello…",
  pageDone: () => "✅ Trello підключено. Вкладка закриється сама.",
  alreadyConnected: () => "Trello вже підключено. Для перепідключення передайте force=true.",
  statusModeUnset: () => "не задано (вам запропонують обрати)",
  statusHint: () => 'Викличте trello_connect з {"mode":"auto"} або {"mode":"manual"}.',
};

export const dictionaries: Record<Lang, Record<Key, Entry>> = { en, ru, uk };

export function t(key: Key, vars: V = {}, lang: Lang = currentLang()): string {
  return dictionaries[lang][key](vars);
}

/** Locale for timestamps in the log. */
export const localeFor = (lang: Lang = currentLang()) => ({ en: "en-GB", ru: "ru-RU", uk: "uk-UA" })[lang];
