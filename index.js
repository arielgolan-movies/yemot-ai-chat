import express from 'express';
import { YemotRouter } from 'yemot-router2';
import { GoogleGenAI } from '@google/genai';

// ===== הגדרות (משתני סביבה ב-Render) =====
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;          // מפתח חינמי מ-Google AI Studio
const YEMOT_TOKEN    = process.env.YEMOT_TOKEN;             // "מספר_מערכת:סיסמה"
const MODEL          = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const REC_DIR        = process.env.REC_DIR || '/9';         // שלוחה לשמירת ההקלטות
const MAX_TURNS      = 20;                                   // כמה תורות לכל שיחה

const SYSTEM_PROMPT = `אתה עוזר קולי חברותי בשיחת טלפון בעברית.
ענה תמיד בעברית, במשפטים קצרים וטבעיים (עד 3 משפטים), בלי רשימות, אימוג'ים או סימנים מיוחדים.
מחזירים JSON בלבד: {"transcript": "מה שהמתקשר אמר", "reply": "התשובה שלך", "end": false}
אם המתקשר רוצה לסיים (להתראות, ביי, תודה זהו), החזר end=true עם משפט פרידה קצר.
אם ההקלטה ריקה או לא ברורה, בקש בנימוס שיחזור על דבריו.`;

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
    return call.id_list_message([{ type: 'text', data: 'אירעה תקלה, נסו שוב מאוחר יותר' }]);
  }
});

router.get('/', async (call) => {
  const history = [];
  let prompt = 'שלום, אני הבינה המלאכותית שלכם. דברו אחרי הצליל ובסיום הקישו סולמית';

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const recPath = await call.read([{ type: 'text', data: prompt }], 'record', {
      path: REC_DIR,
      file_name: `${call.callId}_${turn}`,
      no_confirm_menu: true,   // סולמית = אישור מיידי, בלי תפריט
      min_length: 1,
      max_length: 40,
      removeInvalidChars: true
    });

    const audio = await downloadRecording(recPath);
    const { transcript, reply, end } = await askGemini(history, audio);

    history.push({ role: 'user',  parts: [{ text: transcript || '(לא ברור)' }] });
    history.push({ role: 'model', parts: [{ text: reply }] });

    if (end) {
      return call.id_list_message([{ type: 'text', data: clean(reply) }]);
    }
    prompt = clean(reply);
  }
  return call.id_list_message([{ type: 'text', data: 'הגענו לסוף השיחה, תודה ולהתראות' }]);
});

const app = express();
app.use(express.urlencoded({ extended: true }));
app.get('/health', (_, res) => res.send('ok'));   // לשמירה על השרת ער
app.use('/yemot', router.asExpressRouter ?? router);
app.listen(process.env.PORT || 3000, () => console.log('AI phone line running'));
