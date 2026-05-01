import { Redis } from '@upstash/redis';
import axios from 'axios';

// ==========================================
// НАСТРОЙКИ БАЗЫ ДАННЫХ UPSTASH (ОБЯЗАТЕЛЬНО ВСТАВЬТЕ СВОИ)
// ==========================================
const UPSTASH_URL = 'https://willing-cicada-111832.upstash.io
'; // Например: https://us1-xxx.upstash.io
const UPSTASH_TOKEN = 'gQAAAAAAAbTYAAIgcDE3OWExNWY2NTdkMTk0NDE1ODA3YzNiY2Y5OThkYTYwYg
'; // Длинная строка с буквами и цифрами

const redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });

// ==========================================
// ЭКОНОМИКА ИГРЫ
// ==========================================
const ROOM_SIZE = 4;
const TIMER_SECONDS = 60;
const AD_REVENUE_TON = 0.002; // Доход за 1 рекламу
const FUND_SHARE_PERCENT = 60; // % от дохода идущий в призовой фонд

const FAUCETPAY_API_KEY = process.env.FAUCETPAY_API_KEY; 
const FAUCETPAY_CURRENCY = 'TON';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    const { action, userId, roomId, to } = req.body;

    if (!userId) return res.status(400).json({ error: 'No userId' });

    try {
        let user = await redis.get(`user:${userId}`);
        if (!user) {
            user = { ton_balance: 0 };
            await redis.set(`user:${userId}`, user);
        } else if (typeof user.ton_balance === 'string') {
            user.ton_balance = parseFloat(user.ton_balance); // Защита от типов Redis
        }

        if (action === 'join') {
            let joinedRoom = null;
            const roomKeys = await redis.keys('room:*'); 
            
            for (let key of roomKeys) {
                const room = await redis.get(key);
                if (room && Array.isArray(room.players) && room.players.length < ROOM_SIZE && !room.ended && !room.players.includes(userId)) {
                    joinedRoom = room;
                    break;
                }
            }

            if (!joinedRoom) {
                const newRoomId = 'room-' + Date.now();
                joinedRoom = {
                    roomId: newRoomId,
                    players: [userId],
                    fund: 0,
                    started: false,
                    ended: false,
                    lastActionTime: Date.now(),
                    lastActionUser: null
                };
                await redis.set(`room:${newRoomId}`, joinedRoom);
            } else {
                joinedRoom.players.push(userId);
                if (joinedRoom.players.length === ROOM_SIZE) {
                    joinedRoom.started = true;
                    joinedRoom.lastActionTime = Date.now(); 
                }
                await redis.set(`room:${joinedRoom.roomId}`, joinedRoom);
            }

            return res.json({ 
                status: joinedRoom.started ? 'playing' : 'waiting', 
                roomId: joinedRoom.roomId, 
                playerCount: joinedRoom.players.length, 
                fund: joinedRoom.fund,
                userBalance: user.ton_balance
            });
        }

        if (action === 'ad_click') {
            const room = await redis.get(`room:${roomId}`);
            if (!room || room.ended) return res.json({ success: false, message: 'Room ended' });

            const amountToFund = AD_REVENUE_TON * (FUND_SHARE_PERCENT / 100);
            room.fund = Number(room.fund) + amountToFund;
            room.lastActionTime = Date.now();
            room.lastActionUser = userId;

            await redis.set(`room:${roomId}`, room);
            return res.json({ success: true, newFund: room.fund });
        }

        if (action === 'poll') {
            const room = await redis.get(`room:${roomId}`);
            if (!room) return res.json({ status: 'error' });

            const timePassed = (Date.now() - room.lastActionTime) / 1000;
            const remainingTime = room.started ? Math.max(0, TIMER_SECONDS - Math.floor(timePassed)) : TIMER_SECONDS;

            if (room.started && remainingTime <= 0 && !room.ended) {
                room.ended = true;
                
                const totalFund = Number(room.fund);
                const winnerPrize = totalFund * 0.60;
                const loserPrize = totalFund * 0.10;
                const adminCut = totalFund * 0.10;
                const winnerId = room.lastActionUser;

                let admin = await redis.get(`user:777000`);
                if (!admin) admin = { ton_balance: 0 };
                admin.ton_balance = Number(admin.ton_balance) + adminCut;
                await redis.set(`user:777000`, admin);

                if (winnerId) {
                    let winnerData = await redis.get(`user:${winnerId}`);
                    if(winnerData) {
                        winnerData.ton_balance = Number(winnerData.ton_balance) + winnerPrize;
                        await redis.set(`user:${winnerId}`, winnerData);
                    }
                }

                for (let pId of room.players) {
                    if (pId !== winnerId) {
                        let loserData = await redis.get(`user:${pId}`);
                        if(loserData) {
                            loserData.ton_balance = Number(loserData.ton_balance) + loserPrize;
                            await redis.set(`user:${pId}`, loserData);
                        }
                    }
                }

                await redis.set(`room:${roomId}`, room);
                user = await redis.get(`user:${userId}`);

                return res.json({
                    status: 'ended',
                    winnerId: winnerId,
                    winnerPrize: winnerPrize,
                    loserPrize: loserPrize,
                    fund: totalFund,
                    userBalance: user.ton_balance
                });
            }

            return res.json({
                status: room.ended ? 'ended' : (room.started ? 'playing' : 'waiting'),
                playerCount: room.players.length,
                fund: Number(room.fund), 
                remainingTime: remainingTime,
                userBalance: user.ton_balance
            });
        }

        if (action === 'withdraw') {
            const amountToWithdraw = Number(user.ton_balance);
            const MIN_WITHDRAW = 0.1;

            if (amountToWithdraw < MIN_WITHDRAW) {
                return res.json({ success: false, message: `Мин. сумма вывода ${MIN_WITHDRAW} TON` });
            }
            if (!FAUCETPAY_API_KEY) {
                return res.json({ success: false, message: "Вывод временно отключен админом." });
            }

            try {
                const fpResponse = await axios.post('https://faucetpay.io/api/v1/send', new URLSearchParams({
                    api_key: FAUCETPAY_API_KEY,
                    amount: amountToWithdraw.toFixed(8),
                    to: to,
                    currency: FAUCETPAY_CURRENCY
                }));

                const fpData = fpResponse.data;

                if (fpData.status === 200) {
                    user.ton_balance = 0;
                    await redis.set(`user:${userId}`, user);
                    return res.json({ 
                        success: true, 
                        message: `Выплачено!`, 
                        amount: amountToWithdraw,
                        newBalance: user.ton_balance
                    });
                } else {
                    return res.json({ 
                        success: false, 
                        message: `Ошибка FaucetPay: ${fpData.message}` 
                    });
                }
            } catch (error) {
                return res.json({ success: false, message: "Ошибка сервера при выводе." });
            }
        }

    } catch (error) {
        console.error("SERVER ERROR:", error);
        return res.status(500).json({ error: error.message });
    }
}
