require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const cors = require('cors');

const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure proxy trust if behind a proxy (like Cloudflare)
if (process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', true);
    console.log('Proxy trust enabled - will use X-Forwarded-For headers for rate limiting');
}

// Custom logging middleware for all requests
app.use((req, res, next) => {
    try {
        const startTime = Date.now();
        const originalSend = res.send;
        const originalJson = res.json;
        let responseSize = 0;
        
        // Override res.send to capture response size
        res.send = function(data) {
            try {
                if (data != null) {
                    try {
                        let dataString;
                        if (typeof data === 'string') {
                            dataString = data;
                        } else if (Buffer.isBuffer(data)) {
                            responseSize = data.length;
                            return originalSend.call(this, data);
                        } else {
                            // For objects, numbers, booleans, etc. - convert to string
                            dataString = typeof data === 'object' ? JSON.stringify(data) : String(data);
                        }
                        responseSize = Buffer.byteLength(dataString, 'utf8');
                    } catch (error) {
                        responseSize = 0; // Fallback if size calculation fails
                        console.error('[HTTP] Error calculating response size:', error.message);
                    }
                }
                return originalSend.call(this, data);
            } catch (error) {
                console.error('[HTTP] Error in res.send override:', error.message);
                return originalSend.call(this, data);
            }
        };
        
        // Also override res.json for JSON responses
        res.json = function(data) {
            try {
                if (data != null) {
                    try {
                        const jsonString = JSON.stringify(data);
                        responseSize = Buffer.byteLength(jsonString, 'utf8');
                    } catch (error) {
                        responseSize = 0;
                        console.error('[HTTP] Error calculating JSON response size:', error.message);
                    }
                }
                return originalJson.call(this, data);
            } catch (error) {
                console.error('[HTTP] Error in res.json override:', error.message);
                return originalJson.call(this, data);
            }
        };
        
        // Log when response finishes
        res.on('finish', () => {
            try {
                const duration = Date.now() - startTime;
                const ip = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || 
                          (req.connection?.socket ? req.connection.socket.remoteAddress : null) || 'Unknown';
                const userAgent = req.get('User-Agent') || 'Unknown';
                const contentLength = req.get('Content-Length') || '0';
                
                console.log(`[HTTP] ${new Date().toISOString()} | ${req.method} ${req.originalUrl || req.url} | ${res.statusCode} | ${ip} | ${duration}ms | Req: ${contentLength}B | Res: ${responseSize}B | UA: ${userAgent}`);
            } catch (error) {
                console.error('[HTTP] Error logging request:', error.message);
            }
        });
        
        // Handle errors on the response object
        res.on('error', (error) => {
            console.error('[HTTP] Response error:', error.message);
        });
        
        next();
    } catch (error) {
        console.error('[HTTP] Error in logging middleware:', error.message);
        next(); // Continue even if logging fails
    }
});

// Store messages in memory (simple array)
let messages = [];
const MAX_MESSAGES = 100; // Keep only last 100 messages

// Store typing users
let typingUsers = new Map();
const TYPING_TIMEOUT = 5000; // 5 seconds

// Bot presence management
let lastApiRequest = Date.now();
let isOnline = false;
const PRESENCE_TIMEOUT = 15000; // 15 seconds of inactivity before going DND

// Function to update bot presence
async function updateBotPresence() {
    try {
        if (!client.user) return;
        
        const now = Date.now();
        const timeSinceLastRequest = now - lastApiRequest;
        
        if (timeSinceLastRequest < PRESENCE_TIMEOUT && !isOnline) {
            // Set to online
            await client.user.setPresence({
                status: 'online',
                activities: [{
                    name: 'Web Chat Active',
                    type: 0 // Playing
                }]
            });
            isOnline = true;
            console.log('[BOT] Bot status set to online');
        } else if (timeSinceLastRequest >= PRESENCE_TIMEOUT && isOnline) {
            // Set to DND
            await client.user.setPresence({
                status: 'dnd',
                activities: [{
                    name: 'Web Chat Idle',
                    type: 0 // Playing
                }]
            });
            isOnline = false;
            console.log('[BOT] Bot status set to DND');
        }
    } catch (error) {
        console.error('[BOT] Error updating bot presence:', error.message);
    }
}

// Check presence every 10 seconds
setInterval(updateBotPresence, 10000);

// Rate limiting configurations
const passwordRateLimit = rateLimit({
    windowMs: 2 * 1000, // 2 seconds
    max: 1, // 1 attempt per 2 seconds per IP
    message: { error: 'Too many password attempts, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    // Disable validation checks if behind proxy
    validate: process.env.TRUST_PROXY === 'true' ? {
        xForwardedForHeader: false,
        trustProxy: false
    } : undefined
});

const messageRateLimit = rateLimit({
    windowMs: 1 * 1000, // 1 second
    max: 1, // 1 message per second per IP
    message: { error: 'Too many messages, please slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
    // Disable validation checks if behind proxy
    validate: process.env.TRUST_PROXY === 'true' ? {
        xForwardedForHeader: false,
        trustProxy: false
    } : undefined
});

const typingRateLimit = rateLimit({
    windowMs: 4 * 1000, // 4 seconds
    max: 1, // 1 typing indicator per 4 seconds per IP
    message: { error: 'Typing indicator rate limit exceeded.' },
    standardHeaders: true,
    legacyHeaders: false,
    // Disable validation checks if behind proxy
    validate: process.env.TRUST_PROXY === 'true' ? {
        xForwardedForHeader: false,
        trustProxy: false
    } : undefined
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Discord bot setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageTyping,
        GatewayIntentBits.DirectMessageTyping
    ]
});

// Bot ready event
client.once('ready', async () => {
    try {
        console.log(`[BOT] Discord bot logged in as ${client.user.tag}`);
        
        // Set initial presence to DND
        await client.user.setPresence({
            status: 'dnd',
            activities: [{
                name: 'Web Chat Idle',
                type: 0 // Playing
            }]
        });
        
        // Fetch initial message history
        await fetchDiscordHistory();
    } catch (error) {
        console.error('[BOT] Error in ready event:', error.message);
    }
});

// Add error event handler for Discord client
client.on('error', (error) => {
    console.error('[BOT] Discord client error:', error.message);
});

// Add warning event handler
client.on('warn', (warning) => {
    console.warn('[BOT] Discord client warning:', warning);
});

// Add disconnect handler
client.on('disconnect', () => {
    console.log('[BOT] Discord client disconnected');
});

// Add reconnecting handler
client.on('reconnecting', () => {
    console.log('[BOT] Discord client reconnecting...');
});

// Function to fetch Discord message history (last 7 days)
async function fetchDiscordHistory() {
    try {
        let channel;
        try {
            // Try to fetch as a channel first
            channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
        } catch (error) {
            // If that fails, try to fetch as a user and create DM
            const user = await client.users.fetch(process.env.DISCORD_CHANNEL_ID);
            channel = await user.createDM();
        }
        
        // Calculate date 7 days ago
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        
        // Fetch messages
        const fetchedMessages = await channel.messages.fetch({ limit: 100 });
        
        // Filter messages from last 7 days and convert to our format
        const recentMessages = fetchedMessages
            .filter(msg => msg.createdAt > sevenDaysAgo)
            .sort((a, b) => a.createdAt - b.createdAt)
            .map(msg => {
                // Extract media URLs from message
                const mediaUrls = [];
                
                // Check for attachments (images, files)
                if (msg.attachments.size > 0) {
                    msg.attachments.forEach(attachment => {
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
                if (msg.embeds.length > 0) {
                    msg.embeds.forEach(embed => {
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
                const urlMatches = msg.content.match(urlRegex);
                if (urlMatches) {
                    urlMatches.forEach(url => {
                        mediaUrls.push({
                            url: url,
                            type: 'image',
                            filename: 'linked_image'
                        });
                    });
                }
                
                // Determine message source
                let source = 'Discord';
                let isBot = false;
                
                if (msg.author.bot) {
                    isBot = true;
                    if (msg.webhookId) {
                        source = 'Webhook';
                    } else {
                        source = 'Bot';
                    }
                }
                
                // Parse username from web messages
                let author = msg.author.username;
                let content = msg.content;
                
                // If it's from our bot and has the web format, extract the real username
                if (msg.author.id === process.env.DISCORD_BOT_CLIENT_ID && content.startsWith('**') && content.includes('**: ')) {
                    const match = content.match(/^\*\*(.+?)\*\*: (.+)$/);
                    if (match) {
                        author = match[1];
                        content = match[2];
                        source = 'Web';
                        isBot = false;
                    }
                }
                
                return {
                    id: msg.id,
                    author: author,
                    content: content,
                    timestamp: msg.createdAt.toISOString(),
                    source: source,
                    isBot: isBot,
                    media: mediaUrls
                };
            });
        
        // Replace current messages with history
        messages = recentMessages.slice(-MAX_MESSAGES);
        
        console.log(`[BOT] Loaded ${messages.length} messages from Discord history`);
    } catch (error) {
        console.error('[BOT] Error fetching Discord history:', error);
    }
}

// Function to trigger typing indicator in Discord
async function triggerDiscordTyping(channelId) {
    try {
        let channel;
        try {
            // Try to fetch as a channel first
            channel = await client.channels.fetch(channelId);
        } catch (error) {
            // If that fails, try to fetch as a user and create DM
            const user = await client.users.fetch(channelId);
            channel = await user.createDM();
        }
        
        // Send typing indicator
        await channel.sendTyping();
        console.log('[BOT] Typing indicator sent to Discord');
    } catch (error) {
        console.error('[BOT] Error sending typing indicator:', error.message);
    }
}

// Listen for messages from Discord
client.on('messageCreate', async (message) => {
    try {
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
        
        try {
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
        } catch (error) {
            console.error('[BOT] Error processing message media:', error.message);
        }
        
        // Determine message source
        let source = 'Discord';
        let isBot = false;
        
        if (message.author.bot) {
            isBot = true;
            if (message.webhookId) {
                source = 'Webhook';
            } else {
                source = 'Bot';
            }
        }
        
        // Handle Discord replies
        let replyTo = null;
        if (message.reference && message.reference.messageId) {
            try {
                const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
                if (referencedMessage) {
                    let originalAuthor = referencedMessage.author.username;
                    let originalContent = referencedMessage.content;
                    
                    // If replying to a bot message, extract the original web username
                    if (referencedMessage.author.bot && referencedMessage.content.startsWith('**')) {
                        const match = referencedMessage.content.match(/^\*\*([^*]+)\*\*: (.*)/);
                        if (match) {
                            originalAuthor = match[1]; // Extract web username
                            originalContent = match[2]; // Extract actual message content
                        }
                    }
                    
                    replyTo = {
                        id: referencedMessage.id,
                        author: originalAuthor,
                        content: originalContent,
                        timestamp: referencedMessage.createdAt.toISOString()
                    };
                }
            } catch (error) {
                console.log('[BOT] Could not fetch referenced message:', error.message);
            }
        }

        // Add message to our array
        const messageData = {
            id: message.id,
            author: message.author.username || 'Unknown',
            content: message.content || '',
            timestamp: new Date().toISOString(),
            source: source,
            isBot: isBot,
            media: mediaUrls,
            replyTo: replyTo
        };
        
        messages.push(messageData);
        
        // Keep only last MAX_MESSAGES
        if (messages.length > MAX_MESSAGES) {
            messages = messages.slice(-MAX_MESSAGES);
        }
        
        // Log the received message
        try {
            const mediaInfo = mediaUrls.length > 0 ? ` [Media: ${mediaUrls.length} items]` : '';
            const replyInfo = replyTo ? ` [Reply to: ${replyTo.author}]` : '';
            console.log(`[MSG_IN] ${new Date().toISOString()} | Discord | ${message.author.username || 'Unknown'}: ${message.content || '(empty)'}${mediaInfo}${replyInfo}`);
        } catch (error) {
            console.error('[BOT] Error logging received message:', error.message);
        }
    } catch (error) {
        console.error('[BOT] Error processing Discord message:', error.message);
    }
});



// API Routes

// Password validation endpoint with rate limiting
app.post('/api/validate-password', passwordRateLimit, (req, res) => {
    try {
        const { password } = req.body;
        const isValid = password === process.env.CHAT_PASSWORD;
        res.json({ valid: isValid });
    } catch (error) {
        console.error('[API] Error validating password:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get all messages (with password protection)
app.post('/api/messages', (req, res) => {
    try {
        const { password } = req.body;
        if (password !== process.env.CHAT_PASSWORD) {
            return res.status(401).json({ error: 'Invalid password' });
        }
        
        // Update last API request time for presence management
        lastApiRequest = Date.now();
        
        // Get current typing users (excluding expired ones)
        const now = Date.now();
        const activeTypingUsers = [];
        
        for (const [username, timestamp] of typingUsers.entries()) {
            try {
                if (now - timestamp < 5000) { // 5 second timeout
                    activeTypingUsers.push(username);
                } else {
                    typingUsers.delete(username);
                }
            } catch (error) {
                console.error('[API] Error processing typing user:', error.message);
                typingUsers.delete(username); // Remove problematic entry
            }
        }
        
        res.json({ 
            messages,
            typing: activeTypingUsers
        });
    } catch (error) {
        console.error('[API] Error getting messages:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Handle typing indicators with rate limiting
app.post('/api/typing', typingRateLimit, async (req, res) => {
    try {
        const { username, password, isTyping } = req.body;
        
        // Validate password
        if (password !== process.env.CHAT_PASSWORD) {
            return res.status(401).json({ error: 'Invalid password' });
        }
        
        const user = username || 'elianka';
        
        if (isTyping) {
            // Add user to typing list
            typingUsers.set(user, Date.now());
            
            // Trigger Discord typing indicator
            await triggerDiscordTyping(process.env.DISCORD_CHANNEL_ID);
            
            // Set timeout to remove user from typing list
            setTimeout(() => {
                const lastTyping = typingUsers.get(user);
                if (lastTyping && Date.now() - lastTyping >= TYPING_TIMEOUT - 100) {
                    typingUsers.delete(user);
                }
            }, TYPING_TIMEOUT);
        } else {
            // Remove user from typing list
            typingUsers.delete(user);
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('[API] Error handling typing indicator:', error);
        res.status(500).json({ error: 'Failed to handle typing indicator' });
    }
});

// Purge bot messages endpoint
app.post('/api/purge-bot-messages', messageRateLimit, (req, res) => {
    try {
        const { password } = req.body;
        
        // Validate password
        if (password !== process.env.CHAT_PASSWORD) {
            return res.status(401).json({ error: 'Invalid password' });
        }
        
        // Count bot messages before purging
        const botMessagesBefore = messages.filter(msg => msg.isBot).length;
        
        // Remove last 100 bot messages
        let removedCount = 0;
        for (let i = messages.length - 1; i >= 0 && removedCount < 100; i--) {
            if (messages[i].isBot) {
                messages.splice(i, 1);
                removedCount++;
            }
        }
        
        console.log(`[API] Purged ${removedCount} bot messages`);
        res.json({ 
            success: true, 
            removedCount: removedCount,
            message: `Successfully purged ${removedCount} bot messages` 
        });
    } catch (error) {
        console.error('[API] Error purging bot messages:', error);
        res.status(500).json({ error: 'Failed to purge bot messages' });
    }
});

// Send message to Discord with rate limiting
app.post('/api/send', messageRateLimit, async (req, res) => {
    try {
        const { message, username, password, replyTo } = req.body;
        
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
        
        // Trigger typing indicator before sending
        await triggerDiscordTyping(process.env.DISCORD_CHANNEL_ID);
        
        // Prepare message options
        const messageOptions = {
            content: `**${username || 'elianka'}**: ${message}`
        };
        
        // Add Discord reply if this is a reply to a Discord message
        if (replyTo && replyTo.id) {
            try {
                // Try to fetch the original message to reply to
                const originalMessage = await channel.messages.fetch(replyTo.id);
                if (originalMessage) {
                    messageOptions.reply = {
                        messageReference: originalMessage,
                        failIfNotExists: false
                    };
                }
            } catch (error) {
                console.log('[API] Could not fetch original message for reply, sending as regular message:', error.message);
                // Fallback to text-based reply if Discord reply fails
                messageOptions.content = `**${username || 'elianka'}** replying to **${replyTo.author}**: "${replyTo.content.substring(0, 100)}${replyTo.content.length > 100 ? '...' : ''}"
${message}`;
            }
        }
        
        await channel.send(messageOptions);
        
        // Add to our local messages array
        const messageData = {
            id: Date.now().toString(),
            author: username || 'elianka',
            content: message,
            timestamp: new Date().toISOString(),
            source: 'Web',
            isBot: false,
            media: [],
            replyTo: replyTo || null
        };
        
        // Remove user from typing list since they sent a message
        typingUsers.delete(username || 'elianka');
        
        messages.push(messageData);
        
        // Keep only last MAX_MESSAGES
        if (messages.length > MAX_MESSAGES) {
            messages = messages.slice(-MAX_MESSAGES);
        }
        
        // Log the sent message
        const replyInfo = replyTo ? ` [Reply to: ${replyTo.author}]` : '';
        console.log(`[MSG_OUT] ${new Date().toISOString()} | Web->Discord | ${username || 'elianka'}: ${message}${replyInfo}`);
        
        res.json({ success: true, message: 'Message sent' });
    } catch (error) {
        console.error('[API] Error sending message:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Global error handlers for uncaught exceptions and rejections
process.on('uncaughtException', (error) => {
    console.error('[FATAL] Uncaught Exception:', error.message);
    console.error('[FATAL] Stack:', error.stack);
    // Don't exit the process - let it continue running
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] Unhandled Rejection at:', promise);
    console.error('[FATAL] Reason:', reason);
    // Don't exit the process - let it continue running
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`[SERVER] Server running on http://localhost:${PORT}`);
});

// Handle server errors
server.on('error', (error) => {
    console.error('[SERVER] Server error:', error.message);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('[SERVER] Received SIGINT, shutting down gracefully...');
    server.close(() => {
        console.log('[SERVER] Server closed');
        if (client) {
            client.destroy();
            console.log('[BOT] Discord client destroyed');
        }
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('[SERVER] Received SIGTERM, shutting down gracefully...');
    server.close(() => {
        console.log('[SERVER] Server closed');
        if (client) {
            client.destroy();
            console.log('[BOT] Discord client destroyed');
        }
        process.exit(0);
    });
});

// Login to Discord
client.login(process.env.DISCORD_BOT_TOKEN).catch((error) => {
    console.error('[BOT] Failed to login to Discord:', error.message);
    // Don't exit - allow the web server to continue running even if Discord fails
});
