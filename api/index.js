const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');
const axios = require('axios');
const cron = require('node-cron'); // <--- YE HAI MAIN CHEEZ (ALARM CLOCK)

const app = express();

// --- CONFIGURATION ---
// Vercel Environment Variables se values lega
const ZAPUPI_ENV = process.env.ZAPUPI_ENV || 'TEST';
const ZAPUPI_URL = 'https://api.zapupi.com/v1/create-order'; // Zapupi API Endpoint

// --- FIREBASE SETUP ---
if (!admin.apps.length) {
    let privateKey = process.env.FIREBASE_PRIVATE_KEY;
    if (privateKey) {
        if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
            privateKey = privateKey.slice(1, -1);
        }
        privateKey = privateKey.replace(/\\n/g, '\n');
    }

    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: privateKey
        })
    });
}
const db = admin.firestore();

// --- MIDDLEWARE ---
app.use(cors({ origin: true }));
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf.toString();
    }
}));

// --- SECURITY GUARDS (POLICE) ---

// 1. Verify User (Sabke liye)
const verifyToken = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized: No Token' });
        }
        const token = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken;
        next();
    } catch (error) {
        return res.status(403).json({ error: 'Invalid or Expired Token' });
    }
};

// 2. Verify Admin (Sirf Admin Routes ke liye)
const verifyAdmin = (req, res, next) => {
    const ADMIN_EMAILS = ["admin123@gmail.com", "owner@esports.com"]; 
    
    if (req.user && ADMIN_EMAILS.includes(req.user.email)) {
        next(); 
    } else {
        return res.status(403).json({ error: "Access Denied: Admins Only" });
    }
};

// --- AUTOMATIC MATCH STARTER (CRON JOB) ---
cron.schedule('* * * * *', async () => {
    console.log("⏰ Checking for matches to start...");
    const now = Date.now();

    try {
        const snapshot = await db.collection('matches')
            .where('status', '==', 'Upcoming')
            .where('unlockTimestamp', '<=', now)
            .get();

        if (snapshot.empty) return;

        const batch = db.batch();
        
        snapshot.docs.forEach(doc => {
            batch.update(doc.ref, { status: 'Playing' });
            console.log(`✅ Auto-Started Match: ${doc.id}`);
        });

        await batch.commit();
    } catch (error) {
        console.error("❌ Auto-Start Error:", error);
    }
});

// --- API ROUTES ---

// 1. Join Match (Team Logic included)
app.post('/api/match/join', verifyToken, async (req, res) => {
    try {
        const { matchId, gameUids } = req.body; 
        const uid = req.user.uid;

        await db.runTransaction(async (t) => {
            const mRef = db.collection('matches').doc(matchId);
            const uRef = db.collection('users').doc(uid);
            const teamRef = mRef.collection('teams').doc(uid);

            const mDoc = await t.get(mRef);
            const uDoc = await t.get(uRef);
            const tDoc = await t.get(teamRef);

            if(tDoc.exists) throw new Error("You have already joined this match!");
            if(uDoc.data().wallet < mDoc.data().entryFee) throw new Error("Insufficient Balance! Please Add Cash.");

            t.update(uRef, { 
                wallet: uDoc.data().wallet - mDoc.data().entryFee, 
                joinedMatches: admin.firestore.FieldValue.arrayUnion(matchId) 
            });

            t.update(mRef, { joinedCount: admin.firestore.FieldValue.increment(1) });

            t.set(teamRef, { 
                ownerUid: uid,
                captainName: uDoc.data().username,
                avatar: uDoc.data().avatar || null,
                gameUids: gameUids, 
                joinedAt: admin.firestore.FieldValue.serverTimestamp(), 
                hasReceivedRewards: false 
            });
        });
        res.json({ success: true, message: "Joined Successfully" });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// 2. Admin Distribute (Prize & XP Logic) - SECURED
app.post('/api/admin/match/distribute', verifyToken, verifyAdmin, async (req, res) => {
    const { matchId, gameUid, rank, kills } = req.body;
    
    try {
        const matchRef = db.collection('matches').doc(matchId);
        
        const teamQuery = await matchRef.collection('teams')
            .where('gameUids', 'array-contains', gameUid) 
            .limit(1).get();

        if (teamQuery.empty) return res.status(404).json({ error: 'Player UID not found in any team!' });

        const teamDoc = teamQuery.docs[0];
        const teamRef = teamDoc.ref;
        const ownerUid = teamDoc.data().ownerUid; 

        await db.runTransaction(async (t) => {
            const mDoc = await t.get(matchRef);
            const tDoc = await t.get(teamRef);

            if (tDoc.data().hasReceivedRewards) throw new Error("Rewards already distributed to this team!");

            const mData = mDoc.data();
            const killPrize = kills * (mData.perKill || 0);
            const rankPrize = (mData.rankPrizes && mData.rankPrizes[rank-1]) || 0;
            const totalCash = killPrize + rankPrize;
            
            const totalXp = 100 + (kills * 10);

            const uRef = db.collection('users').doc(ownerUid);
            const uDoc = await t.get(uRef);

            t.update(uRef, { 
                wallet: (uDoc.data().wallet || 0) + totalCash, 
                xp: (uDoc.data().xp || 0) + totalXp,
                matchesPlayed: admin.firestore.FieldValue.increment(1), 
                totalKills: admin.firestore.FieldValue.increment(kills) 
            });

            t.update(teamRef, { 
                hasReceivedRewards: true, 
                resultRank: rank, 
                resultKills: kills, 
                prizeWon: totalCash 
            });

            if (totalCash > 0) {
                db.collection('transactions').add({ 
                    userId: ownerUid, 
                    type: 'prize_winnings', 
                    amount: totalCash, 
                    matchId, 
                    status: 'SUCCESS', 
                    timestamp: admin.firestore.FieldValue.serverTimestamp() 
                });
            }
        });
        res.json({ success: true, message: `Sent ₹${totalCash} to Captain` });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// 3. Wallet - Withdraw Request
app.post('/api/wallet/withdraw', verifyToken, async (req, res) => {
    const { amount, upiId } = req.body;
    const uid = req.user.uid;
    const userRef = db.collection('users').doc(uid);
    
    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (doc.data().wallet < amount) throw new Error("Insufficient funds");
            
            t.update(userRef, { wallet: doc.data().wallet - amount });
            
            db.collection('transactions').add({ 
                userId: uid, 
                type: 'withdraw', 
                amount: parseFloat(amount), 
                upi: upiId, 
                status: 'Pending', 
                timestamp: admin.firestore.FieldValue.serverTimestamp() 
            });
        });
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// 4. Wallet - Create Deposit Order (Zapupi)
app.post('/api/wallet/createOrder', verifyToken, async (req, res) => {
    try {
        const { amount } = req.body;
        const uid = req.user.uid;
        const orderId = `ZAP_${uid.slice(0,5)}_${Date.now()}`;

        const userDoc = await db.collection('users').doc(uid).get();
        if(!userDoc.exists) return res.status(404).json({error: "User not found"});

        const payload = {
            api_key: process.env.ZAPUPI_API_KEY,
            order_id: orderId,
            amount: amount,
            name: userDoc.data().username,
            email: userDoc.data().email,
            mobile: "9999999999",
            callback_url: process.env.ZAPUPI_CALLBACK_URL,
            note: "Wallet Deposit"
        };

        const zapupiRes = await axios.post(ZAPUPI_URL, payload);

        if (zapupiRes.data && zapupiRes.data.status) {
            await db.collection('transactions').add({
                userId: uid, type: 'deposit', amount: parseFloat(amount), status: 'PENDING',
                orderId: orderId, 
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            res.json({ payment_url: zapupiRes.data.payment_url, order_id: orderId });
        } else {
            throw new Error("Zapupi Order Creation Failed");
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5. Zapupi Webhook (Auto-Confirm Payment)
app.post('/api/webhook/zapupi', async (req, res) => {
    try {
        const { order_id, status, amount } = req.body;

        if (status === 'COMPLETED' || status === 'SUCCESS') {
            const q = await db.collection('transactions').where('orderId', '==', order_id).limit(1).get();
            
            if (!q.empty && q.docs[0].data().status !== 'SUCCESS') {
                await db.runTransaction(async (t) => {
                    const tRef = q.docs[0].ref;
                    const uRef = db.collection('users').doc(q.docs[0].data().userId);
                    const uDoc = await t.get(uRef);
                    
                    t.update(uRef, { wallet: (uDoc.data().wallet || 0) + parseFloat(amount) });
                    t.update(tRef, { status: 'SUCCESS' });
                });
            }
        }
        res.send('OK');
    } catch (e) { res.status(500).send('Error'); }
});

// 6. Daily Reward API
app.post('/api/rewards/daily', verifyToken, async (req, res) => {
    try {
        const uid = req.user.uid;
        const uRef = db.collection('users').doc(uid);
        
        await db.runTransaction(async (t) => {
            const doc = await t.get(uRef);
            const last = doc.data().lastDailyReward?.toDate();
            
            if(last && (new Date() - last) < 86400000) throw new Error("Please wait 24 hours for next reward!");

            const rewardAmt = 10; 
            
            t.update(uRef, { 
                wallet: (doc.data().wallet || 0) + rewardAmt, 
                lastDailyReward: admin.firestore.FieldValue.serverTimestamp() 
            });
            
            db.collection('transactions').add({ 
                userId: uid, 
                type: 'daily_reward', 
                amount: rewardAmt, 
                status: 'SUCCESS', 
                timestamp: admin.firestore.FieldValue.serverTimestamp() 
            });
        });
        res.json({ success: true, amount: 10 });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// 7. Test Route
app.get('/api', (req, res) => {
    res.send("Esports Backend with Zapupi is Running! 🚀");
});

module.exports = app;
    
