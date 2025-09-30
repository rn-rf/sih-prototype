const express = require('express');
const cors = require('cors');
const fileUpload = require('express-fileupload');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(fileUpload({ limits: { fileSize: 50 * 1024 * 1024 } })); // 50MB limit
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: "*" },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Enhanced room structure
const rooms = {};

function generateRoomCode() {
  let code;
  do {
    code = Math.random().toString(36).substring(2, 8).toUpperCase();
  } while (rooms[code]); // Ensure uniqueness
  return code;
}

// Create room
app.get('/create', (req, res) => {
  const code = generateRoomCode();
  rooms[code] = { 
    master: null, 
    viewers: new Map(), // Map of socket.id -> {socketId, joinedAt}
    currentSlide: '', 
    currentSlideIndex: 0,
    slides: [],
    doodles: [],
    createdAt: Date.now()
  };
  res.redirect(`/master.html?code=${code}`);
});

// Join room
app.get('/join', (req, res) => {
  const { code, nickname } = req.query;
  if (rooms[code]) {
    res.redirect(`/viewer.html?code=${code}&nickname=${encodeURIComponent(nickname || 'Anonymous')}`);
  } else {
    res.send("<div>Room not found. <a href='/'>Go back</a></div>");
  }
});

// Upload slides with better error handling
app.post('/upload-ppt', async (req, res) => {
  try {
    if (!req.files || !req.files.ppt) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const ppt = req.files.ppt;
    const code = req.body.code;
    
    if (!rooms[code]) {
      return res.status(400).json({ error: 'Invalid room code' });
    }

    const roomDir = path.join(__dirname, 'uploads', code);
    if (!fs.existsSync(roomDir)) {
      fs.mkdirSync(roomDir, { recursive: true });
    }

    const filePath = path.join(roomDir, ppt.name);
    await ppt.mv(filePath);

    let pdfPath = filePath;
    
    // Convert PPT/PPTX to PDF
    if (/\.(pptx?|ppt)$/i.test(ppt.name)) {
      pdfPath = filePath.replace(/\.(pptx?|ppt)$/i, '.pdf');
      try {
        execSync(`libreoffice --headless --convert-to pdf "${filePath}" --outdir "${roomDir}"`, {
          timeout: 30000
        });
      } catch (err) {
        console.error('LibreOffice conversion error:', err);
        return res.status(500).json({ error: 'Failed to convert PPT to PDF' });
      }
    }

    // Convert PDF to images
    const slidesDir = path.join(roomDir, 'slides');
    if (!fs.existsSync(slidesDir)) {
      fs.mkdirSync(slidesDir, { recursive: true });
    }

    try {
      execSync(`magick -density 150 "${pdfPath}" "${slidesDir}/slide-%03d.png"`, {
        timeout: 60000
      });
    } catch (err) {
      console.error('ImageMagick conversion error:', err);
      return res.status(500).json({ error: 'Failed to convert PDF to images' });
    }

    const slides = fs.readdirSync(slidesDir)
      .filter(f => f.endsWith('.png'))
      .sort()
      .map(f => `/uploads/${code}/slides/${f}`);

    // Store slides in room
    rooms[code].slides = slides;

    res.json({ slides });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Get room info
app.get('/room-info/:code', (req, res) => {
  const { code } = req.params;
  const room = rooms[code];
  
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  res.json({
    viewerCount: room.viewers.size,
    slideCount: room.slides.length,
    currentSlide: room.currentSlideIndex
  });
});

// Socket.io with improved WebRTC handling
io.on('connection', socket => {
  console.log("User connected:", socket.id);

  socket.on('join-room', ({ code, role, nickname }) => {
    if (!rooms[code]) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    const room = rooms[code];
    socket.join(code);

    if (role === 'master') {
      if (room.master && room.master !== socket.id) {
        socket.emit('error', { message: 'Room already has a master' });
        return;
      }
      room.master = socket.id;
      socket.emit('room-joined', { 
        role: 'master',
        viewerCount: room.viewers.size,
        slides: room.slides 
      });
    } else {
      room.viewers.set(socket.id, { socketId: socket.id, nickname: nickname || 'Anonymous', joinedAt: Date.now() });
      
      // Send ALL slides to viewer
      if (room.slides.length > 0) {
        socket.emit('all-slides', { slides: room.slides, currentIndex: room.currentSlideIndex });
      }
      
      // Send current state to new viewer
      if (room.currentSlide) {
        socket.emit('slide-update', { 
          src: room.currentSlide,
          index: room.currentSlideIndex 
        });
      }
      
      // Send all doodles
      room.doodles.forEach(d => socket.emit('doodle', d));
      
      socket.emit('room-joined', { role: 'viewer' });
      
      // Notify master of new viewer
      if (room.master) {
        io.to(room.master).emit('viewer-joined', { 
          viewerId: socket.id,
          nickname: nickname || 'Anonymous',
          viewerCount: room.viewers.size 
        });
      }
    }
    
    console.log(`${role} joined room ${code}`);
  });

  // Slide update with index tracking
  socket.on('slide-update', ({ code, src, index }) => {
    const room = rooms[code];
    if (!room || room.master !== socket.id) return;
    
    room.currentSlide = src;
    room.currentSlideIndex = index || 0;
    room.doodles = []; // Clear doodles on slide change
    
    socket.to(code).emit('slide-update', { src, index });
    socket.to(code).emit('clear-doodles');
  });

  // Doodle with limits
  socket.on('doodle', ({ code, x, y }) => {
    const room = rooms[code];
    if (!room || room.master !== socket.id) return;
    
    // Limit doodle history to prevent memory issues
    if (room.doodles.length > 10000) {
      room.doodles = room.doodles.slice(-5000);
    }
    
    room.doodles.push({ x, y });
    socket.to(code).emit('doodle', { x, y });
  });

  // Clear doodles
  socket.on('clear-doodles', ({ code }) => {
    const room = rooms[code];
    if (!room || room.master !== socket.id) return;
    
    room.doodles = [];
    socket.to(code).emit('clear-doodles');
  });

  // Viewer response
  socket.on('response', ({ code, response }) => {
    const room = rooms[code];
    if (room && room.master) {
      const viewer = room.viewers.get(socket.id);
      const nickname = viewer ? viewer.nickname : 'Anonymous';
      io.to(room.master).emit('response', { 
        from: socket.id,
        nickname: nickname,
        response,
        timestamp: Date.now()
      });
    }
  });

  // WebRTC signaling - FIXED for mesh architecture
  socket.on('webrtc-offer', ({ code, offer, to }) => {
    const room = rooms[code];
    if (!room) return;
    
    if (to) {
      // Direct offer to specific peer
      io.to(to).emit('webrtc-offer', { offer, from: socket.id });
    } else if (room.master && socket.id !== room.master) {
      // Viewer to master
      io.to(room.master).emit('webrtc-offer', { offer, from: socket.id });
    }
    console.log(`Offer from ${socket.id} to ${to || 'master'}`);
  });

  socket.on('webrtc-answer', ({ code, answer, to }) => {
    if (to) {
      io.to(to).emit('webrtc-answer', { answer, from: socket.id });
      console.log(`Answer from ${socket.id} to ${to}`);
    }
  });

  socket.on('webrtc-candidate', ({ code, candidate, to }) => {
    if (to) {
      io.to(to).emit('webrtc-candidate', { candidate, from: socket.id });
    } else {
      socket.to(code).emit('webrtc-candidate', { candidate, from: socket.id });
    }
  });

  // Close room
  socket.on('close-room', ({ code }) => {
    const room = rooms[code];
    if (room && room.master === socket.id) {
      io.to(code).emit('room-closed');
      
      // Cleanup files
      const roomDir = path.join(__dirname, 'uploads', code);
      if (fs.existsSync(roomDir)) {
        fs.rmSync(roomDir, { recursive: true, force: true });
      }
      
      delete rooms[code];
      console.log(`Room ${code} closed by master`);
    }
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    for (const code in rooms) {
      const room = rooms[code];
      
      if (room.master === socket.id) {
        // Master disconnected - close room
        io.to(code).emit('room-closed');
        
        // Cleanup
        const roomDir = path.join(__dirname, 'uploads', code);
        if (fs.existsSync(roomDir)) {
          fs.rmSync(roomDir, { recursive: true, force: true });
        }
        
        delete rooms[code];
        console.log(`Master disconnected. Room ${code} closed`);
      } else if (room.viewers.has(socket.id)) {
        // Viewer disconnected
        room.viewers.delete(socket.id);
        
        if (room.master) {
          io.to(room.master).emit('viewer-left', { 
            viewerId: socket.id,
            viewerCount: room.viewers.size 
          });
        }
        console.log(`Viewer ${socket.id} left room ${code}`);
      }
    }
  });
});

// Cleanup old rooms every hour
setInterval(() => {
  const now = Date.now();
  const maxAge = 4 * 60 * 60 * 1000; // 4 hours
  
  for (const code in rooms) {
    if (now - rooms[code].createdAt > maxAge) {
      const roomDir = path.join(__dirname, 'uploads', code);
      if (fs.existsSync(roomDir)) {
        fs.rmSync(roomDir, { recursive: true, force: true });
      }
      delete rooms[code];
      console.log(`Cleaned up old room: ${code}`);
    }
  }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));