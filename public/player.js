// --- CONFIGURATION ---
const FPS = 15; // Must match the FPS you used in ffmpeg!
const TOTAL_FRAMES = 54000; // Change this to the actual number of frames you generated!

// --- PLAYER ELEMENTS ---
const image = document.getElementById('player_image');
const audio = document.getElementById('player_audio');
const playPauseBtn = document.getElementById('play_pause_btn');

// --- PLAYER STATE ---
let currentFrame = 1;
let isPlaying = false;
let playerInterval = null;

// --- PRELOADING LOGIC ---
// To make playback smoother, we'll try to load the next few images ahead of time.
const preloadBuffer = [];
const PRELOAD_AHEAD = 10; // How many frames to load in advance.

function preloadImages() {
    for (let i = 1; i <= PRELOAD_AHEAD; i++) {
        const frameNum = currentFrame + i;
        if (frameNum <= TOTAL_FRAMES) {
            const img = new Image();
            img.src = getFramePath(frameNum);
            preloadBuffer.push(img);
        }
    }
}

// --- CORE PLAYER LOGIC ---
function getFramePath(frameNumber) {
    // Formats the number with leading zeros (e.g., 1 -> "00001")
    const frameString = String(frameNumber).padStart(5, '0');
    return `frames/frame_${frameString}.jpg`;
}

function updateFrame() {
    if (currentFrame > TOTAL_FRAMES) {
        pauseVideo();
        return;
    }

    // Set the image source to the next frame
    image.src = getFramePath(currentFrame);

    // Preload the next image in the sequence to reduce stutter
    const nextFrameToPreload = currentFrame + PRELOAD_AHEAD;
    if (nextFrameToPreload <= TOTAL_FRAMES) {
        const nextImage = new Image();
        nextImage.src = getFramePath(nextFrameToPreload);
    }
    
    currentFrame++;
}

function playVideo() {
    if (isPlaying) return;
    isPlaying = true;
    playPauseBtn.textContent = 'Pause';
    audio.play();
    // The interval is the heart of the player. It calls updateFrame() every 1000/FPS milliseconds.
    playerInterval = setInterval(updateFrame, 1000 / FPS);
}

function pauseVideo() {
    if (!isPlaying) return;
    isPlaying = false;
    playPauseBtn.textContent = 'Play';
    audio.pause();
    clearInterval(playerInterval);
}

// --- EVENT LISTENERS ---
playPauseBtn.addEventListener('click', () => {
    if (isPlaying) {
        pauseVideo();
    } else {
        playVideo();
    }
});

// Start by preloading the first few images
preloadImages();
console.log("Player ready. Press play to start.");