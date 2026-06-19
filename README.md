# 🔪 Mafiya — Online Multiplayer

Node.js + Socket.IO ilə hazırlanmış real-time Mafiya oyunu.

## Quraşdırma

```bash
npm install
npm start
```

Brauzderdə: `http://localhost:3000`

## Render.com Deploy

1. GitHub-a push et
2. Render-də "New Web Service" → repo seç
3. Build command: `npm install`
4. Start command: `node server.js`

## Oyun qaydaları

| Oyunçu sayı | Mafia | Dedektiv | Həkim | Vətəndaş |
|-------------|-------|----------|-------|----------|
| 4           | 1     | 1        | 1     | 1        |
| 5–6         | 2     | 1        | 1     | 2–3      |
| 7–9         | 2     | 1        | 1     | 4–6      |
| 10+         | 3     | 1        | 1     | qalanlar |

### Fazalar
- **Gecə (40 san)** — Mafia öldürür, Həkim qoruyur, Dedektiv yoxlayır
- **Gündüz (60 san)** — Müzakirə, nominasiya
- **Səsvermə (30 san)** — Ən çox səs alan xaric edilir

### Qalib şərtləri
- **Şəhər** — Bütün Mafia üzvlərini xaric et
- **Mafia** — Canlı Mafia ≥ Canlı Şəhər
