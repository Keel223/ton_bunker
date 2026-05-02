import { Redis } from '@upstash/redis';
import crypto from 'crypto';
const UPSTASH_URL = 'https://willing-cicada-111832.upstash.io
'; 
const UPSTASH_TOKEN = 'gQAAAAAAAbTYAAIgcDE3OWExNWY2NTdkMTk0NDE1ODA3YzNiY2Y5OThkYTYwYg
';
const redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });

// ВСТАВЬТЕ СЕКРЕТНЫЙ КЛЮЧ ИЗ НАСТРОЕК БЛОКА ADSGRAM
const ADSGRAM_SECRET = 'ВАШ_СЕКРЕТНЫЙ_КЛЮЧ_ОТ_ADSGRAM'; 

const AD_REVENUE_TON = 0.002; // Доход за 1 рекламу
const FUND_SHARE_PERCENT = 60; // % в фонд

export default async function handler(req, res) {
    // AdsGram присылает GET запрос
    if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

    try {
        const { userId, roomId, signature } = req.query;

        if (!userId || !roomId) return res.status(400).json({ error: 'Missing data' });

        // 1. ПРОВЕРКА ПОДПИСИ (ЗАЩИТА ОТ НАКРУТКИ)
        const expectedSignature = crypto.createHash('sha256').update(`${userId}${ADSGRAM_SECRET}`).digest('hex');
        if (signature !== expectedSignature) {
            return res.status(403).json({ error: 'Invalid signature' });
        }

        // 2. НАЧИСЛЕНИЕ В ФОНД
        const room = await redis.get(`room:${roomId}`);
        if (!room || room.ended) return res.status(200).json({ success: true, message: 'Room ended or not found' });

        const amountToFund = AD_REVENUE_TON * (FUND_SHARE_PERCENT / 100);
        room.fund = parseFloat(room.fund || 0) + amountToFund;
        room.lastActionTime = Date.now();
        room.lastActionUser = parseInt(userId); // Сохраняем ID того, кто нажал

        await redis.set(`room:${roomId}`, room);

        return res.status(200).json({ success: true, newFund: room.fund });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
