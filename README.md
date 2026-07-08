---
title: Hebrew Auto-Translate Subtitles
emoji: 🎬
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# Stremio — כתוביות בעברית בתרגום אוטומטי 🇮🇱

אדון (addon) ל-Stremio שמושך כתוביות **באנגלית** מ-OpenSubtitles v3 ומתרגם אותן **לעברית** בזמן אמת דרך Google Translate. סרט שלם מתורגם תוך כמה שניות, והתוצאה נשמרת בקאש כך שצפייה חוזרת (או דילוג אחורה) מיידית.

## דרישות

- Node.js 18 ומעלה (אין תלויות חיצוניות — לא צריך `npm install`)

## הפעלה

```bash
cd stremio-hebrew-translate
node server.js
```

השרת עולה על פורט 7860 (ניתן לשינוי עם משתנה הסביבה `PORT`).

## התקנה ב-Stremio

1. ודא שהשרת רץ.
2. ב-Stremio: **Add-ons ← חפש בשדה הכתובת למעלה** והדבק:

   ```
   http://127.0.0.1:7860/manifest.json
   ```

3. לחץ **Install**.
4. בזמן צפייה בסרט/פרק, פתח את תפריט הכתוביות — יופיעו אפשרויות בעברית (`heb`) מהאדון "Hebrew Auto-Translate Subtitles".

> הבחירה הראשונה בכתובית מפעילה את התרגום — לוקח כ-5–15 שניות לסרט שלם, ואז הכתוביות נטענות. מהפעם השנייה זה מיידי (קאש בתיקיית `cache/`).

## הגדרות (משתני סביבה)

| משתנה | ברירת מחדל | תיאור |
|---|---|---|
| `PORT` | `7860` | פורט השרת |
| `SOURCE_ADDONS` | `https://opensubtitles-v3.strem.io` | כתובות בסיס של אדוני מקור (מופרדות בפסיק, נבדקות לפי הסדר) |
| `MAX_SUBS` | `5` | כמה גרסאות כתוביות להציע לכל כותר |
| `TARGET_LANG` | `iw` | שפת יעד (קוד Google Translate) |

דוגמה — הוספת אדון מקור נוסף:

```bash
SOURCE_ADDONS="https://opensubtitles-v3.strem.io,https://my-other-addon.example.com" node server.js
```

## איך זה עובד

1. Stremio שולח בקשת `subtitles` עם מזהה IMDB של הסרט/הפרק.
2. השרת שואל את אדון המקור, מסנן כתוביות באנגלית, ומחזיר ל-Stremio רשימת כתוביות בעברית שה-URL שלהן מצביע חזרה לשרת.
3. כשבוחרים כתובית, השרת מוריד את ה-SRT האנגלי, מפרק אותו ל-cues, מתרגם באצוות של 100 שורות במקביל, בונה SRT עברי (עם סימוני RTL לתצוגה נכונה של פיסוק) ומחזיר אותו.

## הערות

- שימוש ב-Stremio Web (בדפדפן) דורש HTTPS — לזה צריך להריץ את השרת מאחורי כתובת מאובטחת (למשל Cloudflare Tunnel או פריסה ל-Render/Railway). באפליקציית Desktop ו-Android, כתובת `http://127.0.0.1` מקומית עובדת.
- התרגום הוא מכונה (Google Translate) — לא ברמה של כתוביות אנושיות מ-Ktuvit, אבל זמין לכל תוכן שיש לו כתוביות באנגלית.
