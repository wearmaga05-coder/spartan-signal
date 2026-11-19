const WebSocket = require('ws');

exports.handler = async function (event) {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    try {
        const body = JSON.parse(event.body || '{}');
        const action = body.action || 'ticks';
        const derivKey = (body.derivKey || '').trim();
        const timeframe = body.timeframe || '1m';
        const lang = body.lang || 'ru';

        const prices = await fetchDerivFromServer(derivKey);

        if (action === 'ticks') {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ ok: true, prices })
            };
        }

        const rsi = calcRSI(prices, 14);
        const emaFast = calcEMA(prices, 9);
        const emaSlow = calcEMA(prices, 21);
        const trend = emaFast > emaSlow ? 'BULLISH' : 'BEARISH';

        const aiKey = (body.aiKey || '').trim();
        const aiProvider = (body.aiProvider || 'openai').toLowerCase();

        if (!aiKey) {
            const isRise = (rsi < 35) || (trend === 'BULLISH' && rsi < 68);
            const prob = Math.min(91, Math.max(67, Math.round(Math.abs(50 - rsi) * 0.8 + 65)));
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    ok: true,
                    prices,
                    source: 'SPARTAN MATH',
                    direction: isRise ? 'Rise' : 'Fall',
                    probability: prob,
                    candles: 18,
                    reason: lang === 'ru'
                        ? `RSI(14): ${rsi}, тренд EMA: ${isRise ? 'вверх' : 'вниз'}`
                        : `RSI(14): ${rsi}, EMA trend: ${isRise ? 'up' : 'down'}`
                })
            };
        }

        const prompt = `Analyze Volatility 100 (1s) Index on ${timeframe}. Last 40 ticks: ${prices.slice(-40).join(', ')}. RSI(14)=${rsi}, EMA9=${emaFast.toFixed(2)}, EMA21=${emaSlow.toFixed(2)} (${trend}).
Respond ONLY with raw JSON (no markdown):
{"direction":"Rise" or "Fall","probability":number 68-93,"candles":number 15-20,"reason":"short reason in ${lang === 'ru' ? 'Russian' : 'English'} max 7 words"}`;

        let aiText = '';
        if (aiProvider === 'gemini') {
            const res = await fetch(`https://googleapis.com{aiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error.message);
            aiText = data.candidates[0].content.parts[0].text;
        } else {
            const url = aiProvider === 'deepseek'
                ? 'https://deepseek.com'
                : 'https://openai.com';
            const model = aiProvider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini';

            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiKey}` },
                body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.3 })
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error.message);
            aiText = data.choices[0].message.content;
        }

        const parsed = JSON.parse(aiText.replace(/```json|```/g, '').trim());
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                ok: true,
                prices,
                source: `AI (${aiProvider.toUpperCase()})`,
                direction: parsed.direction === 'Fall' ? 'Fall' : 'Rise',
                probability: parsed.probability || 84,
                candles: parsed.candles || 18,
                reason: parsed.reason || 'AI Pattern'
            })
        };
    } catch (err) {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ ok: false, error: err.message })
        };
    }
};

function fetchDerivFromServer(derivKey) {
    return new Promise((resolve, reject) => {
        const isAppId = /^\d+$/.test(derivKey);
        const appId = isAppId ? derivKey : '1089';
        const ws = new WebSocket(`wss://://derivws.com{appId}`);
        const timer = setTimeout(() => { ws.close(); reject(new Error('Таймаут Deriv')); }, 6500);

        ws.on('open', () => {
            if (derivKey && !isAppId) {
                ws.send(JSON.stringify({ authorize: derivKey }));
            } else {
                ws.send(JSON.stringify({ ticks_history: '1HZ100V', adjust_start_time: 1, count: 70, end: 'latest', style: 'ticks' }));
            }
        });

        ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.error) {
                if (msg.msg_type === 'authorize') {
                    ws.send(JSON.stringify({ ticks_history: '1HZ100V', adjust_start_time: 1, count: 70, end: 'latest', style: 'ticks' }));
                } else {
                    clearTimeout(timer); ws.close(); reject(new Error(msg.error.message));
                }
                return;
            }
            if (msg.msg_type === 'authorize') {
                ws.send(JSON.stringify({ ticks_history: '1HZ100V', adjust_start_time: 1, count: 70, end: 'latest', style: 'ticks' }));
            }
            if (msg.history?.prices) {
                clearTimeout(timer); ws.close(); resolve(msg.history.prices.map(Number));
            }
        });

        ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
}

function calcRSI(data, period = 14) {
    if (data.length <= period) return 50;
    let gains = 0, losses = 0;
    for (let i = data.length - period; i < data.length; i++) {
        const diff = data[i] - data[i - 1];
        if (diff >= 0) gains += diff; else losses -= diff;
    }
    if (losses === 0) return 100;
    return Math.round(100 - (100 / (1 + (gains / period) / (losses / period))));
}

function calcEMA(data, period) {
    const k = 2 / (period + 1);
    let ema = data[0];
    for (let i = 1; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
    return ema;
}
