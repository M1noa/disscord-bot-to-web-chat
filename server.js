require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Store messages in memory (simple array)
let messages = [];
const MAX_MESSAGES = 100; // Keep only last 100 messages

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Discord bot setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ]
});

// Bot ready event
client.once('ready', () => {
    console.log(`Discord bot logged in as ${client.user.tag}`);
});

// Listen for messages from Discord
client.on('messageCreate', async (message) => {
    // Check if it's a DM with the specified user or a message in the specified channel
    const isTargetDM = message.channel.type === 1 && 
        (message.author.id === process.env.DISCORD_CHANNEL_ID || 
         (message.channel.recipient && message.channel.recipient.id === process.env.DISCORD_CHANNEL_ID));
    const isTargetChannel = message.channel.id === process.env.DISCORD_CHANNEL_ID;
    
    if (!isTargetDM && !isTargetChannel) return;
    
    // Don't process messages from our own bot
    if (message.author.id === process.env.DISCORD_BOT_CLIENT_ID) return;
    
    // Extract media URLs from message
    const mediaUrls = [];
    
    // Check for attachments (images, files)
    if (message.attachments.size > 0) {
        message.attachments.forEach(attachment => {
            if (attachment.contentType && attachment.contentType.startsWith('image/')) {
                mediaUrls.push({
                    url: attachment.url,
                    type: 'image',
                    filename: attachment.name
                });
            }
        });
    }
    
    // Check for embeds (links that Discord auto-embeds)
    if (message.embeds.length > 0) {
        message.embeds.forEach(embed => {
            if (embed.image) {
                mediaUrls.push({
                    url: embed.image.url,
                    type: 'image',
                    filename: 'embedded_image'
                });
            }
            if (embed.thumbnail) {
                mediaUrls.push({
                    url: embed.thumbnail.url,
                    type: 'image',
                    filename: 'thumbnail'
                });
            }
        });
    }
    
    // Check for URLs in message content that might be images
    const urlRegex = /(https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|bmp|svg))/gi;
    const urlMatches = message.content.match(urlRegex);
    if (urlMatches) {
        urlMatches.forEach(url => {
            mediaUrls.push({
                url: url,
                type: 'image',
                filename: 'linked_image'
            });
        });
    }
    
    // Add message to our array
    const messageData = {
        id: message.id,
        author: message.author.username,
        content: message.content,
        timestamp: new Date().toISOString(),
        source: 'discord',
        media: mediaUrls
    };
    
    messages.push(messageData);
    
    // Keep only last MAX_MESSAGES
    if (messages.length > MAX_MESSAGES) {
        messages = messages.slice(-MAX_MESSAGES);
    }
    
    console.log(`Discord message: ${message.author.username}: ${message.content}`);
});

// API Routes

// Password validation endpoint
app.post('/api/validate-password', (req, res) => {
    const { password } = req.body;
    const isValid = password === process.env.CHAT_PASSWORD;
    res.json({ valid: isValid });
});

// Get all messages (with password protection)
app.post('/api/messages', (req, res) => {
    const { password } = req.body;
    if (password !== process.env.CHAT_PASSWORD) {
        return res.status(401).json({ error: 'Invalid password' });
    }
    res.json(messages);
});

// Send message to Discord
app.post('/api/send', async (req, res) => {
    try {
        const { message, username, password } = req.body;
        
        // Validate password first
        if (password !== process.env.CHAT_PASSWORD) {
            return res.status(401).json({ error: 'Invalid password' });
        }
        
        if (!message || !message.trim()) {
            return res.status(400).json({ error: 'Message cannot be empty' });
        }
        
        let channel;
        try {
            // Try to fetch as a channel first
            channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
        } catch (error) {
            // If that fails, try to fetch as a user and create DM
            try {
                const user = await client.users.fetch(process.env.DISCORD_CHANNEL_ID);
                channel = await user.createDM();
            } catch (dmError) {
                return res.status(404).json({ error: 'Discord channel/user not found' });
            }
        }
        
        // Send message to Discord with username prefix
        const discordMessage = `**${username || 'Web User'}**: ${message}`;
        await channel.send(discordMessage);
        
        // Add to our local messages array
        const messageData = {
            id: Date.now().toString(),
            author: username || 'Web User',
            content: message,
            timestamp: new Date().toISOString(),
            source: 'web'
        };
        
        messages.push(messageData);
        
        // Keep only last MAX_MESSAGES
        if (messages.length > MAX_MESSAGES) {
            messages = messages.slice(-MAX_MESSAGES);
        }
        
        res.json({ success: true, message: 'Message sent' });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

// Login to Discord
client.login(process.env.DISCORD_BOT_TOKEN).catch(console.error);