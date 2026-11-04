import express from 'express';
import { YemotRouter } from 'yemot-router2';
import { GoogleGenAI } from '@google/genai';

// ===== הגדרות (משתני סביבה ב-Render) =====
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;          // מפתח חינמי מ-Google AI Studio
const YEMOT_TOKEN    = process.env.YEMOT_TOKEN || `${process.env.YEMOT_SYSTEM}:${process.env.YEMOT_PASSWORD}`;             // "מספר_מערכת:סיסמה"
const MODEL          = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const REC_DIR        = process.env.REC_DIR || '/9';         // שלוחה לשמירת ההקלטות
const MAX_TURNS      = 20;                                   // כמה תורות לכל שיחה

const SYSTEM_PROMPT = `אתה עוזר קולי בקו טלפון בעברית. רוב המתקשרים הם אנשים בלי סמארטפון, חלקם מבוגרים.
כללים לתשובה (reply):
- עברית פשוטה ויומיומית, כמו בשיחה עם שכן. בלי מילים לועזיות או מונחים טכניים, ואם חייבים, הסבר אותם במילים פשוטות.
- קצר: 2 עד 3 משפטים קצרים בלבד, כי זה מוקרא בטלפון.
- בלי קישורים, כתובות אתרים, רשימות, מספור, כוכביות, אימוג'ים או סימנים מיוחדים.
- לעולם אל תפנה לאתר, לאפליקציה או לוואטסאפ. אם צריך מספר טלפון, אמור אותו ספרה ספרה.
- אם השאלה רפואית, משפטית או כספית חשובה, תן הכוונה כללית והמלץ לפנות לרופא, לעורך דין או לגורם מוסמך.
- אל תשאל שאלה בסוף התשובה, כי אחריה המתקשר שומע תפריט מקשים.
מחזירים JSON בלבד: {"transcript": "מה שהמתקשר אמר", "reply": "התשובה שלך", "end": false}
אם המתקשר רוצה לסיים (להתראות, ביי, תודה זהו), החזר end=true עם משפט פרידה קצר.
אם ההקלטה ריקה או לא ברורה, ב-reply בקש בנימוס שיקיש 1 וינסה לדבר שוב לאט וקרוב לטלפון.`;

// הודעות הקו
const MSG_WELCOME = 'שלום וברוכים הבאים לקו השאלות של הבינה המלאכותית אחרי הצליל אמרו את השאלה שלכם בקצרה ובקול ברור וכשתסיימו לדבר הקישו סולמית אם לא תקישו התשובה תגיע אחרי עשרים שניות אחרי כל תשובה תוכלו להקיש 1 לשאלה נוספת 2 לשמוע את התשובה שוב או 3 לסיום';
const MSG_ASK     = 'אמרו את השאלה אחרי הצליל וכשתסיימו לדבר הקישו סולמית';
const MSG_MENU    = 'לשאלה נוספת הקישו 1 לשמוע את התשובה שוב הקישו 2 לסיום הקישו 3';
const MSG_BYE     = 'תודה שהתקשרתם להתראות';

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// הורדת קובץ ההקלטה מימות המשיח
async function downloadRecording(path) {
  const clean = path.startsWith('ivr2:') ? path : `ivr2:${path.startsWith('/') ? '' : '/'}${path}`;
  const url = `https://www.call2all.co.il/ym/api/DownloadFile?token=${encodeURIComponent(YEMOT_TOKEN)}&path=${encodeURIComponent(clean)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

// שליחת ההקלטה + היסטוריה ל-Gemini
async function askGemini(history, audioB64) {
  const contents = [
    ...history,
    { role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: audioB64 } }] }
  ];
  const res = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: { systemInstruction: SYSTEM_PROMPT, responseMimeType: 'application/json' }
  });
  try { return JSON.parse(res.text); }
  catch { return { transcript: '', reply: res.text || 'סליחה, לא הבנתי', end: false }; }
}

// ימות לא מקבלת נקודה, מקף, גרש, גרשיים ו-&
const clean = (t) => String(t || '').replace(/[.\-'"&,]/g, ' ').replace(/\s+/g, ' ').trim();

const router = YemotRouter({
  printLog: true,
  timeout: 5 * 60 * 1000,
  uncaughtErrorHandler: (err, call) => {
    console.error(err);
    return call.id_list_message([{ type: 'text', data: 'אירעה תקלה נסו שוב מאוחר יותר' }]);
  }
});

async function record(call, prompt, turn) {
  return call.read([{ type: 'text', data: prompt }], 'record', {
    path: REC_DIR,
    file_name: `${call.callId}_${turn}`,
    no_confirm_menu: true,   // סולמית = אישור מיידי, בלי תפריט
    min_length: 1,
    max_length: 20,   // בלי סולמית ההקלטה נעצרת לבד אחרי 20 שניות
    removeInvalidChars: true
  });
}

// משמיע את התשובה ואז תפריט: 1 שאלה נוספת, 2 שמיעה חוזרת, 3 סיום
async function answerMenu(call, reply) {
  let toPlay = [{ type: 'text', data: reply }, { type: 'text', data: MSG_MENU }];
  for (let i = 0; i < 5; i++) {
    const key = await call.read(toPlay, 'tap', {
      max_digits: 1, min_digits: 1, digits_allowed: ['1', '2', '3'],
      sec_wait: 10, removeInvalidChars: true
    });
    if (key === '2') { toPlay = [{ type: 'text', data: reply }, { type: 'text', data: MSG_MENU }]; continue; }
    if (key === '3') return 'end';
    if (key === '1') return 'ask';
    toPlay = [{ type: 'text', data: MSG_MENU }];
  }
  return 'end';
}

router.get('/', async (call) => {
  const history = [];
  let prompt = MSG_WELCOME;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const recPath = await record(call, prompt, turn);
    const audio = await downloadRecording(recPath);
    const { transcript, reply, end } = await askGemini(history, audio);

    history.push({ role: 'user',  parts: [{ text: transcript || '(לא ברור)' }] });
    history.push({ role: 'model', parts: [{ text: reply }] });

    if (end) return call.id_list_message([{ type: 'text', data: clean(reply) }]);

    const next = await answerMenu(call, clean(reply));
    if (next === 'end') return call.id_list_message([{ type: 'text', data: MSG_BYE }]);
    prompt = MSG_ASK;
  }
  return call.id_list_message([{ type: 'text', data: 'הגענו לסוף השיחה, תודה ולהתראות' }]);
});

const app = express();
app.use(express.urlencoded({ extended: true }));
app.get('/health', (_, res) => res.send('ok'));   // לשמירה על השרת ער
app.use('/yemot', router.asExpressRouter ?? router);
app.listen(process.env.PORT || 3000, () => console.log('AI phone line running'));
