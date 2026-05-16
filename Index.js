const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Base Route to check if backend is live
app.get('/', (req, res) => {
    res.send('Vortex Arena Payment Backend is running!');
});

/**
 * Payment Order Create Route
 * This endpoint receives payment details from your frontend and requests a payment/QR from the gateway
 */
app.post('/api/create-order', async (req, res) => {
    try {
        const { amount, customerName, customerEmail, orderId } = req.body;

        // Replace these with your actual payment gateway API details
        const gatewayUrl = 'https://api.yourpaymentgateway.com/v1/orders'; 
        const apiKey = 'YOUR_API_KEY_HERE'; 

        // Payload structure might vary slightly depending on your exact gateway
        const paymentPayload = {
            amount: amount, // Ensure this matches gateway rules (e.g., paise vs rupees)
            currency: 'INR',
            receipt: orderId || `receipt_${Date.now()}`,
            customer: {
                name: customerName,
                email: customerEmail
            },
            payment_capture: 1 
        };

        // Sending the request to the Payment Gateway API
        const response = await axios.post(gatewayUrl, paymentPayload, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        // Sending back the gateway response (containing QR or payment URL) to your frontend
        res.status(200).json({
            success: true,
            message: "Order generated successfully",
            data: response.data 
        });

    } catch (error) {
        console.error('Error creating payment order:', error.response ? error.response.data : error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to generate payment',
            error: error.message
        });
    }
});

// Start the Server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
