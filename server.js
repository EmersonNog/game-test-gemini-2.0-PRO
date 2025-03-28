const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 8080;

// Servir os arquivos estáticos do jogo (HTML, CSS, JS do cliente)
app.use(express.static(path.join(__dirname, "public")));

let players = {}; // Objeto para armazenar dados dos jogadores conectados { socketId: { id, position, rotation, isDead } }
let serverBullets = {}; // Balas gerenciadas pelo servidor { bulletId: { id, ownerId, position, velocity, startTime, life } }
let nextBulletId = 0;

const INITIAL_POS = { x: 0, y: 15, z: 0 };
const INITIAL_ROT = { x: 0, y: 0, z: 0, w: 1 }; // Quaternion identidade

// Evento: Novo jogador conectado
io.on("connection", (socket) => {
  console.log("Um jogador conectou:", socket.id);

  // 1. Criar estado inicial para o novo jogador
  players[socket.id] = {
    id: socket.id,
    position: { ...INITIAL_POS }, // Posição inicial no servidor (cria cópia)
    rotation: { ...INITIAL_ROT }, // Usar Quaternions é melhor para rotação 3D (cria cópia)
    isDead: false,
  };

  // 2. Enviar ao novo jogador seu ID e o estado atual de TODOS os jogadores
  socket.emit("init_self", { id: socket.id, players: players });

  // 3. Notificar os outros jogadores sobre o novo jogador
  socket.broadcast.emit("player_joined", players[socket.id]);

  // --- Tratamento de Eventos do Cliente ---

  // Evento: Jogador moveu/rotacionou
  socket.on("player_update", (data) => {
    if (players[socket.id] && !players[socket.id].isDead) {
      // Atualiza apenas se existe e não está morto
      // *** ADICIONAR LOG AQUI ***
      console.log(
        `Servidor: Recebido player_update de ${socket.id.substring(
          0,
          4
        )}. Nova Pos: x=${data.position.x.toFixed(
          1
        )}, y=${data.position.y.toFixed(1)}, z=${data.position.z.toFixed(1)}`
      );

      players[socket.id].position = data.position;
      players[socket.id].rotation = data.rotation;
    } else {
      // *** LOG OPCIONAL: Ignorando update ***
      // console.log(`Servidor: Ignorando player_update de ${socket.id.substring(0,4)} (jogador não existe ou está morto)`);
    }
    // Não transmitir imediatamente, faremos isso em um loop (game_state_update)
  });

  // Evento: Jogador atirou
  socket.on("player_shoot", (bulletData) => {
    if (players[socket.id] && !players[socket.id].isDead) {
      // Garante que o jogador existe e está vivo
      const bulletId = `bullet_${nextBulletId++}`;
      console.log(
        `Servidor: Recebido tiro de ${socket.id}, criando bala ${bulletId}`
      );
      serverBullets[bulletId] = {
        id: bulletId,
        ownerId: socket.id,
        position: bulletData.position, // Posição inicial da bala
        velocity: bulletData.velocity, // Velocidade inicial
        startTime: Date.now(), // Para calcular posição futura e tempo de vida
        life: 5000, // Tempo de vida em ms (5 segundos)
      };
      // Notificar todos os clientes sobre a nova bala
      io.emit("bullet_fired", serverBullets[bulletId]);
    }
  });

  // Evento: Cliente detectou colisão (ex: com chão)
  socket.on("player_collision", (collisionData) => {
    // Verifica se o jogador existe e AINDA NÃO está marcado como morto no servidor
    if (players[socket.id] && !players[socket.id].isDead) {
      console.log(
        `Servidor: Colisão reportada por ${socket.id}. Tipo: ${
          collisionData?.type || "desconhecido"
        }`
      );
      players[socket.id].isDead = true; // Marcar como "morto" no estado do servidor

      // Notificar todos sobre a explosão e quem explodiu
      io.emit("player_exploded", {
        playerId: socket.id,
        position: players[socket.id].position,
      });

      // Agendar respawn/reset no servidor
      setTimeout(() => {
        // Verifica se o jogador ainda existe (pode ter desconectado nesse meio tempo)
        if (players[socket.id]) {
          players[socket.id].position = { ...INITIAL_POS }; // Posição de respawn
          players[socket.id].rotation = { ...INITIAL_ROT };
          players[socket.id].isDead = false; // Marcar como vivo novamente

          // Notificar o jogador específico que ele foi resetado com seus novos dados
          socket.emit("player_reset", players[socket.id]);

          // Notificar outros que o jogador "voltou" (atualizar estado visual deles)
          socket.broadcast.emit("player_respawned", players[socket.id]);
          console.log(`Servidor: Jogador ${socket.id} resetado.`);
        }
      }, 3000); // Tempo de respawn (3s) - deve ser igual ou maior que no cliente
    } else {
      console.log(
        `Servidor: Colisão reportada por ${socket.id}, mas jogador já está morto ou não existe.`
      );
    }
  });

  // Evento: Jogador desconectou
  socket.on("disconnect", () => {
    console.log("Jogador desconectou:", socket.id);
    const disconnectedPlayerId = socket.id;
    // Remove o jogador do estado do servidor
    delete players[disconnectedPlayerId];
    // Remove balas pertencentes a este jogador (opcional, podem continuar voando)
    // for (const bulletId in serverBullets) {
    //     if (serverBullets[bulletId].ownerId === disconnectedPlayerId) {
    //         delete serverBullets[bulletId];
    //         io.emit('bullet_removed', bulletId);
    //     }
    // }
    // Notificar os outros jogadores que este saiu
    io.emit("player_left", disconnectedPlayerId);
  });
});

// --- Loop de Atualização do Servidor ---
const TICK_RATE = 30; // Envios de estado por segundo
setInterval(() => {
  const now = Date.now();

  // 1. Atualizar e verificar balas
  for (const id in serverBullets) {
    const bullet = serverBullets[id];
    // Verificar tempo de vida
    if (now - bullet.startTime > bullet.life) {
      console.log(`Servidor: Removendo bala ${id} por tempo de vida.`);
      delete serverBullets[id];
      io.emit("bullet_removed", id); // Notificar clientes para remover a bala
    } else {
      // TODO: Detecção de colisão Bala -> Jogador (AQUI no servidor seria o ideal)
      // Iterar por todos os players vivos
      // Calcular posição futura da bala
      // Verificar distância
      // Se colidir -> marcar jogador como morto, emitir explosão, agendar reset (como em 'player_collision')
    }
  }

  // 2. Transmitir o estado atual de todos os jogadores para todos os clientes
  // Otimização: Poderia enviar apenas os dados que mudaram ou usar delta compression.
  // Para simplicidade, enviamos tudo.
  io.emit("game_state_update", players);
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Acesse http://localhost:${PORT} no seu navegador.`);
});

module.exports = server;
