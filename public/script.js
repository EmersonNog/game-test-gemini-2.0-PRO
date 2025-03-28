import * as THREE from "three";

// --- Variáveis Globais ---
let scene, camera, renderer, clock;
let player = null; // Nosso avião (THREE.Group)
let ground,
  trees = [],
  roads = [];
let bullets = []; // Balas LOCAIS
let keys = {};
let isGameOver = false; // Controla se o jogador local pode interagir
let explosionEffects = [];
let messageElement, infoElement;

// --- Variáveis Globais Multiplayer ---
let socket;
let localPlayerId = null; // ID do nosso socket, definido pelo servidor
let remotePlayers = {}; // { id: { group: THREE.Group, targetPosition: Vector3, targetQuaternion: Quaternion, lastUpdateTime: number } }
let remoteBullets = {}; // { id: { mesh: THREE.Mesh, velocity: Vector3, startTime: number, life: number, ownerId: string } }

// --- Constantes ---
const CAMERA_OFFSET = new THREE.Vector3(0, 8, -20);
const PLANE_SPEED = 25.0;
const BULLET_SPEED = 80.0;
const GROUND_LEVEL = 0;
const COLLISION_THRESHOLD = 0.8;
const MAX_PITCH_RATE = 1.0;
const MAX_ROLL_RATE = 1.8;
const MAX_YAW_RATE = 0.8;
const CONTROL_SENSITIVITY = 2.5;
const CONTROL_DAMPING = 4.0;
const AUTO_BANK_FACTOR = 0.8;
const EXPLOSION_DURATION = 1.5;
const FIREBALL_PARTICLES = 80;
const SMOKE_PARTICLES = 100;
const DEBRIS_PARTICLES = 50;
const FIREBALL_SPEED = 25;
const SMOKE_SPEED = 8;
const DEBRIS_SPEED = 30;
const GRAVITY = 9.8;

// --- Variáveis de Controle Local ---
let targetPitchRate = 0;
let targetRollRate = 0;
let targetYawRate = 0;
let currentPitchRate = 0;
let currentRollRate = 0;
let currentYawRate = 0;

// --- Texturas (Placeholders) ---
const textureLoader = new THREE.TextureLoader();
const fireTexture = textureLoader.load(
  "https://threejs.org/examples/textures/sprites/spark1.png"
);
const smokeTexture = textureLoader.load(
  "https://threejs.org/examples/textures/sprites/cloud.png"
);

// --- Inicialização ---
function init() {
  messageElement = document.getElementById("message");
  infoElement = document.getElementById("info");
  infoElement.innerText = "Conectando ao servidor..."; // Mensagem inicial

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);
  scene.fog = new THREE.Fog(0x87ceeb, 150, 600); // Ajuste a névoa se necessário

  camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
  directionalLight.position.set(10, 20, 5);
  directionalLight.castShadow = true;
  // Configs de sombra (opcional, mas bom ter)
  directionalLight.shadow.mapSize.width = 1024;
  directionalLight.shadow.mapSize.height = 1024;
  directionalLight.shadow.camera.near = 0.5;
  directionalLight.shadow.camera.far = 500;
  directionalLight.shadow.camera.left = -100;
  directionalLight.shadow.camera.right = 100;
  directionalLight.shadow.camera.top = 100;
  directionalLight.shadow.camera.bottom = -100;
  scene.add(directionalLight);

  clock = new THREE.Clock();

  // Criar elementos estáticos primeiro
  createGround();
  createEnvironment();

  // Configurar controles antes de conectar
  setupControls();

  // Conectar ao servidor WebSocket
  connectToServer();

  // Iniciar loop de animação
  animate();
}

// --- Conexão com Servidor WebSocket ---
function connectToServer() {
  // A URL é omitida, pois por padrão conecta ao mesmo host/porta que serviu a página
  socket = io({
    reconnectionAttempts: 5, // Tenta reconectar algumas vezes
    reconnectionDelay: 1000, // Espera 1s entre tentativas
  });

  // --- Tratamento de Eventos do Socket.IO ---

  socket.on("connect", () => {
    console.log("Conectado ao servidor! Aguardando ID...");
    // Limpa mensagens de erro anteriores
    messageElement.style.display = "none";
    infoElement.innerText = "Conectado. Aguardando dados...";
  });

  socket.on("connect_error", (err) => {
    console.error("Falha ao conectar:", err.message);
    messageElement.innerText = "Erro de Conexão!";
    messageElement.style.display = "block";
    infoElement.innerText = "Falha na conexão.";
    isGameOver = true; // Impede interações
  });

  socket.on("disconnect", (reason) => {
    console.error("Desconectado do servidor! Razão:", reason);
    messageElement.innerText = "Desconectado!";
    messageElement.style.display = "block";
    infoElement.innerText = "Desconectado.";
    isGameOver = true; // Impede interações
    // Limpar jogadores remotos e locais da cena
    for (const id in remotePlayers) {
      if (remotePlayers[id].group) scene.remove(remotePlayers[id].group);
    }
    remotePlayers = {};
    if (player) scene.remove(player);
    player = null;
    localPlayerId = null;
    // Limpar balas
    bullets.forEach((b) => scene.remove(b));
    bullets = [];
    for (const id in remoteBullets) {
      if (remoteBullets[id].mesh) scene.remove(remoteBullets[id].mesh);
    }
    remoteBullets = {};
  });

  // Recebe ID e estado inicial do jogo
  socket.on("init_self", (data) => {
    localPlayerId = data.id;
    console.log("Meu ID definido:", localPlayerId);
    infoElement.innerText = `Conectado como ${localPlayerId.substring(
      0,
      4
    )} (Setas/AD: Mover, Espaço: Atirar)`;

    // Criar/Atualizar todos os jogadores recebidos do servidor
    for (const id in data.players) {
      const serverPlayerData = data.players[id];
      if (id === localPlayerId) {
        // É o nosso jogador
        if (!player) {
          // Cria se não existir
          console.log("Criando jogador local:", id);
          createPlayer(id, serverPlayerData, true); // true = isLocal
        } else {
          // Apenas atualiza posição/rotação se já existe (caso de reconexão?)
          player.position.set(
            serverPlayerData.position.x,
            serverPlayerData.position.y,
            serverPlayerData.position.z
          );
          player.quaternion.set(
            serverPlayerData.rotation.x,
            serverPlayerData.rotation.y,
            serverPlayerData.rotation.z,
            serverPlayerData.rotation.w
          );
          player.visible = !serverPlayerData.isDead;
          isGameOver = serverPlayerData.isDead; // Sincroniza estado de "morte"
          if (isGameOver)
            messageElement.innerText = "Você está aguardando respawn...";
          else messageElement.style.display = "none";
        }
      } else {
        // É um jogador remoto
        if (!remotePlayers[id]) {
          // Cria se não existir
          console.log("Criando jogador remoto:", id);
          createPlayer(id, serverPlayerData, false); // false = isRemote
        } else {
          // Atualiza se já existe
          const remote = remotePlayers[id];
          remote.targetPosition.set(
            serverPlayerData.position.x,
            serverPlayerData.position.y,
            serverPlayerData.position.z
          );
          remote.targetQuaternion.set(
            serverPlayerData.rotation.x,
            serverPlayerData.rotation.y,
            serverPlayerData.rotation.z,
            serverPlayerData.rotation.w
          );
          // Define posição/rotação inicial diretamente também para evitar pulo inicial
          remote.group.position.copy(remote.targetPosition);
          remote.group.quaternion.copy(remote.targetQuaternion);
          remote.group.visible = !serverPlayerData.isDead;
        }
      }
    }
    console.log(
      "Estado inicial recebido. Jogadores:",
      Object.keys(data.players).length
    );
  });

  // Novo jogador entrou no jogo
  socket.on("player_joined", (playerData) => {
    // Garante que não é o jogador local e que ainda não existe localmente
    if (playerData.id !== localPlayerId && !remotePlayers[playerData.id]) {
      console.log("Jogador remoto entrou:", playerData.id);
      createPlayer(playerData.id, playerData, false);
    }
  });

  // Jogador saiu do jogo
  socket.on("player_left", (playerId) => {
    console.log("Jogador remoto saiu:", playerId);
    if (remotePlayers[playerId]) {
      scene.remove(remotePlayers[playerId].group);
      // TODO: Adicionar dispose de geometria/material se necessário
      delete remotePlayers[playerId];
    }
  });

  // Recebe atualizações de estado de todos os jogadores (do loop do servidor)
  socket.on("game_state_update", (serverPlayers) => {
    if (!localPlayerId) return; // Ignorar se ainda não fomos inicializados

    // console.log("Received game_state_update. Players in update:", Object.keys(serverPlayers)); // Descomente para ver IDs no update

    for (const id in serverPlayers) {
      const serverState = serverPlayers[id];
      if (id !== localPlayerId) {
        // Atualização de jogador remoto
        if (remotePlayers[id]) {
          // *** LOG ADICIONADO ***
          // Mostra o ID (primeiros 4 chars), a posição alvo recebida do servidor
          console.log(
            `Updating target for remote player ${id.substring(
              0,
              4
            )}. Target Pos: x=${serverState.position.x.toFixed(
              1
            )}, y=${serverState.position.y.toFixed(
              1
            )}, z=${serverState.position.z.toFixed(1)}`
          );

          // Atualiza o *alvo* para interpolação
          remotePlayers[id].targetPosition.set(
            serverState.position.x,
            serverState.position.y,
            serverState.position.z
          );
          remotePlayers[id].targetQuaternion.set(
            serverState.rotation.x,
            serverState.rotation.y,
            serverState.rotation.z,
            serverState.rotation.w
          );
          remotePlayers[id].lastUpdateTime = Date.now(); // Guarda o timestamp da atualização

          // Atualiza visibilidade caso tenha morrido/respawnado entre updates
          const shouldBeVisible = !serverState.isDead;
          if (remotePlayers[id].group.visible !== shouldBeVisible) {
            // *** LOG VISIBILIDADE (OPCIONAL) ***
            console.log(
              `Updating visibility for ${id.substring(
                0,
                4
              )} to ${shouldBeVisible}`
            );
            remotePlayers[id].group.visible = shouldBeVisible;
          }
        } else {
          // Jogador remoto existe no servidor mas não localmente -> Criar
          // *** LOG DE AVISO ***
          console.warn(
            `Received state for unknown remote player ${id}. Creating now... State:`,
            serverState
          );
          createPlayer(id, serverState, false); // Tenta criar o jogador
        }
      } else {
        // Atualização do NOSSO jogador (recebida do servidor)
        // Poderia ser usado para correção de estado se o servidor for autoritativo
        // Ex: if (player && player.position.distanceTo(serverState.position) > threshold) { player.position.lerp(serverState.position, 0.1); }
        // Também sincroniza o estado 'isDead' vindo do servidor
        if (player && isGameOver !== serverState.isDead) {
          console.log(
            `Meu estado 'isDead' atualizado pelo servidor para: ${serverState.isDead}`
          );
          isGameOver = serverState.isDead;
          player.visible = !isGameOver; // Garante visibilidade correta
          if (isGameOver) {
            messageElement.innerText = "Você está aguardando respawn...";
            messageElement.style.display = "block";
            // Não criar explosão aqui, esperar 'player_exploded'
          } else {
            messageElement.style.display = "none";
          }
        }
      }
    }
    // Limpeza: Remove jogadores locais que não vieram mais no update do servidor
    for (const localId in remotePlayers) {
      if (!serverPlayers[localId]) {
        console.warn("Removendo jogador remoto órfão:", localId);
        if (remotePlayers[localId].group)
          scene.remove(remotePlayers[localId].group);
        delete remotePlayers[localId];
      }
    }
  });

  // Recebe notificação de nova bala disparada por alguém
  socket.on("bullet_fired", (bulletData) => {
    // Ignora nossas próprias balas (já as criamos localmente)
    if (bulletData.ownerId !== localPlayerId) {
      createRemoteBullet(bulletData);
    } else {
      // Poderia usar isso para confirmar/corrigir ID da bala local se necessário
    }
  });

  // Recebe notificação para remover uma bala (tempo de vida esgotado, colisão no servidor, etc.)
  socket.on("bullet_removed", (bulletId) => {
    removeRemoteBullet(bulletId); // Tenta remover se for uma bala remota
    // Poderia também remover bala local se o ID corresponder
    const localIndex = bullets.findIndex(
      (b) => b.userData.serverId === bulletId
    ); // Supondo que guardamos serverId
    if (localIndex !== -1) {
      scene.remove(bullets[localIndex]);
      bullets.splice(localIndex, 1);
    }
  });

  // Recebe notificação de explosão de um jogador (incluindo nós mesmos)
  socket.on("player_exploded", (data) => {
    handlePlayerExplosion(data.playerId, data.position);
  });

  // Recebe notificação para resetar o *nosso* jogador após a morte
  socket.on("player_reset", (playerData) => {
    if (playerData.id === localPlayerId) {
      console.log("Ordem de reset recebida do servidor!");
      resetGame(playerData.position, playerData.rotation); // Usa dados do servidor
    }
  });

  // Recebe notificação que um jogador remoto foi resetado/respawnou
  socket.on("player_respawned", (playerData) => {
    if (playerData.id !== localPlayerId && remotePlayers[playerData.id]) {
      console.log(`Jogador remoto ${playerData.id} respawnou`);
      const remote = remotePlayers[playerData.id];
      remote.group.visible = true; // Torna visível novamente
      // Define posição/rotação diretamente (sem interpolação no respawn)
      remote.group.position.set(
        playerData.position.x,
        playerData.position.y,
        playerData.position.z
      );
      remote.group.quaternion.set(
        playerData.rotation.x,
        playerData.rotation.y,
        playerData.rotation.z,
        playerData.rotation.w
      );
      // Reseta alvos de interpolação para evitar pulo
      remote.targetPosition.copy(remote.group.position);
      remote.targetQuaternion.copy(remote.group.quaternion);
    }
  });
}

// --- Criação dos Objetos ---

function createPlayer(id, playerData, isLocal) {
  const playerGroup = new THREE.Group();

  // Cores diferentes para jogador local e remotos
  const bodyColor = isLocal ? 0xaaaaaa : 0x6666ff; // Cinza vs Azul
  const wingColor = isLocal ? 0xdd0000 : 0xffaa00; // Vermelho vs Laranja

  const bodyMat = new THREE.MeshStandardMaterial({
    color: bodyColor,
    metalness: 0.5,
    roughness: 0.6,
  });
  const bodyGeo = new THREE.BoxGeometry(2, 0.8, 5);
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.castShadow = true;
  body.receiveShadow = true;
  playerGroup.add(body);

  const wingMat = new THREE.MeshStandardMaterial({
    color: wingColor,
    metalness: 0.4,
    roughness: 0.7,
  });
  const wingGeo = new THREE.BoxGeometry(8, 0.2, 1.5);
  const wingL = new THREE.Mesh(wingGeo, wingMat);
  wingL.position.set(-4, 0, -0.5);
  wingL.castShadow = true;
  playerGroup.add(wingL);
  const wingR = wingL.clone();
  wingR.position.x = 4;
  playerGroup.add(wingR);

  const tailVGeo = new THREE.BoxGeometry(0.2, 1.5, 1);
  const tailV = new THREE.Mesh(tailVGeo, wingMat);
  tailV.position.set(0, 0.7, 2);
  tailV.castShadow = true;
  playerGroup.add(tailV);

  const tailHGeo = new THREE.BoxGeometry(3, 0.2, 0.8);
  const tailH = new THREE.Mesh(tailHGeo, wingMat);
  tailH.position.set(0, 0.2, 2.2);
  tailH.castShadow = true;
  playerGroup.add(tailH);

  // Definir posição e rotação iniciais do servidor
  playerGroup.position.set(
    playerData.position.x,
    playerData.position.y,
    playerData.position.z
  );
  if (playerData.rotation) {
    playerGroup.quaternion.set(
      playerData.rotation.x,
      playerData.rotation.y,
      playerData.rotation.z,
      playerData.rotation.w
    );
  }

  // Define visibilidade inicial baseada no estado 'isDead' do servidor
  playerGroup.visible = !playerData.isDead;
  playerGroup.userData.playerId = id; // Guarda o ID no userData para referência

  scene.add(playerGroup);

  if (isLocal) {
    player = playerGroup; // Referência global para o jogador local
    isGameOver = playerData.isDead; // Sincroniza estado inicial de game over
    resetPlayerState(); // Reseta taxas de rotação locais
    if (isGameOver) {
      messageElement.innerText = "Você está aguardando respawn...";
      messageElement.style.display = "block";
    }
  } else {
    // Armazena dados para jogadores remotos, incluindo alvos para interpolação
    remotePlayers[id] = {
      group: playerGroup,
      targetPosition: playerGroup.position.clone(),
      targetQuaternion: playerGroup.quaternion.clone(),
      lastUpdateTime: Date.now(),
    };
  }
}

function createGround() {
  const groundTexture = textureLoader.load(
    "https://threejs.org/examples/textures/terrain/grasslight-big.jpg"
  );
  groundTexture.wrapS = THREE.RepeatWrapping;
  groundTexture.wrapT = THREE.RepeatWrapping;
  groundTexture.repeat.set(50, 50);
  const groundMat = new THREE.MeshStandardMaterial({
    map: groundTexture,
    color: 0x55aa55,
    roughness: 0.9,
    metalness: 0.1,
  });
  const groundGeo = new THREE.PlaneGeometry(1000, 1000);
  ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = GROUND_LEVEL;
  ground.receiveShadow = true;
  scene.add(ground);
}

function createTree(x, z) {
  const trunkHeight = Math.random() * 4 + 3;
  const leavesRadius = Math.random() * 1.5 + 1;
  const leavesHeight = Math.random() * 3 + 2;
  const trunkMat = new THREE.MeshStandardMaterial({
    color: 0x8b4513,
    roughness: 0.9,
  });
  const trunkGeo = new THREE.CylinderGeometry(0.3, 0.5, trunkHeight, 8);
  const trunk = new THREE.Mesh(trunkGeo, trunkMat);
  trunk.position.set(x, GROUND_LEVEL + trunkHeight / 2, z);
  trunk.castShadow = true;
  scene.add(trunk);
  trees.push(trunk);
  const leavesMat = new THREE.MeshStandardMaterial({
    color: 0x228b22,
    roughness: 0.8,
  });
  const leavesGeo = new THREE.ConeGeometry(leavesRadius, leavesHeight, 8);
  const leaves = new THREE.Mesh(leavesGeo, leavesMat);
  leaves.position.set(
    x,
    GROUND_LEVEL + trunkHeight + leavesHeight / 2 - 0.5,
    z
  );
  leaves.castShadow = true;
  scene.add(leaves);
  trees.push(leaves);
}

function createRoad(x, z, length, width, rotationY) {
  const roadMat = new THREE.MeshStandardMaterial({
    color: 0x444444,
    roughness: 0.9,
  });
  const roadGeo = new THREE.PlaneGeometry(length, width);
  const road = new THREE.Mesh(roadGeo, roadMat);
  road.rotation.x = -Math.PI / 2;
  road.rotation.z = rotationY;
  road.position.set(x, GROUND_LEVEL + 0.05, z);
  road.receiveShadow = true;
  scene.add(road);
  roads.push(road);
}

function createEnvironment() {
  trees.forEach((tree) => scene.remove(tree));
  roads.forEach((road) => scene.remove(road));
  trees = [];
  roads = [];
  for (let i = 0; i < 150; i++) {
    const x = (Math.random() - 0.5) * 800;
    const z = (Math.random() - 0.5) * 800;
    if (Math.abs(x) > 30 || Math.abs(z) > 30) createTree(x, z);
  }
  createRoad(0, -150, 400, 10, 0);
  createRoad(150, 0, 350, 8, Math.PI / 2);
  createRoad(-100, 100, 200, 6, Math.PI / 4);
}

// Cria bala LOCAL e envia para o servidor
function createBullet() {
  if (isGameOver || !player || !socket || !localPlayerId) return; // Checagens de segurança

  const bulletMat = new THREE.MeshBasicMaterial({ color: 0xffff00 }); // Amarelo para local
  const bulletGeo = new THREE.SphereGeometry(0.3, 8, 8);
  const bulletMesh = new THREE.Mesh(bulletGeo, bulletMat);

  const offset = new THREE.Vector3(0, 0, 3.5); // Posição inicial à frente do nariz
  offset.applyQuaternion(player.quaternion);
  bulletMesh.position.copy(player.position).add(offset);

  const velocity = new THREE.Vector3();
  player.getWorldDirection(velocity); // Direção Z local do avião
  velocity.multiplyScalar(BULLET_SPEED);

  // Adiciona à cena localmente para feedback imediato
  bulletMesh.userData = {
    velocity: velocity.clone(),
    life: 5.0, // Tempo de vida em segundos (local)
    startTime: clock.elapsedTime, // Tempo do jogo local quando foi criada
    // serverId: null // Poderia guardar o ID do servidor aqui quando confirmado
  };
  bullets.push(bulletMesh);
  scene.add(bulletMesh);

  // Envia dados da bala para o servidor (usando objetos simples)
  socket.emit("player_shoot", {
    position: {
      x: bulletMesh.position.x,
      y: bulletMesh.position.y,
      z: bulletMesh.position.z,
    },
    velocity: { x: velocity.x, y: velocity.y, z: velocity.z },
  });
  // console.log("Atirou! Enviando para servidor.");
}

// Cria bala REMOTA vinda do servidor
function createRemoteBullet(bulletData) {
  // Evita duplicar se a notificação chegar e a bala já existir
  if (remoteBullets[bulletData.id]) return;

  // console.log(`Criando bala remota ${bulletData.id} de ${bulletData.ownerId}`);
  const bulletMat = new THREE.MeshBasicMaterial({ color: 0xff8800 }); // Laranja para remota
  const bulletGeo = new THREE.SphereGeometry(0.3, 8, 8);
  const bulletMesh = new THREE.Mesh(bulletGeo, bulletMat);

  bulletMesh.position.set(
    bulletData.position.x,
    bulletData.position.y,
    bulletData.position.z
  );

  remoteBullets[bulletData.id] = {
    mesh: bulletMesh,
    velocity: new THREE.Vector3(
      bulletData.velocity.x,
      bulletData.velocity.y,
      bulletData.velocity.z
    ),
    startTime: bulletData.startTime, // Timestamp do servidor quando foi criada
    life: bulletData.life / 1000.0, // Converter ms (servidor) para segundos (cliente)
    ownerId: bulletData.ownerId,
  };
  scene.add(bulletMesh);
}

// Remove bala REMOTA
function removeRemoteBullet(bulletId) {
  if (remoteBullets[bulletId]) {
    // console.log(`Removendo bala remota ${bulletId}`);
    scene.remove(remoteBullets[bulletId].mesh);
    // TODO: Adicionar dispose se necessário
    delete remoteBullets[bulletId];
  }
}

// --- Criação da Explosão (igual à versão anterior) ---
function createExplosion(position) {
  clearExplosion(); // Limpa explosões antigas
  const fireParticles = createParticleSystem(
    FIREBALL_PARTICLES,
    position,
    fireTexture,
    new THREE.Color(0xffdd88),
    1.5,
    FIREBALL_SPEED,
    0.8,
    THREE.AdditiveBlending
  );
  fireParticles.userData.isFireball = true;
  explosionEffects.push(fireParticles);
  scene.add(fireParticles);
  const smokeParticles = createParticleSystem(
    SMOKE_PARTICLES,
    position,
    smokeTexture,
    new THREE.Color(0x333333),
    2.5,
    SMOKE_SPEED,
    EXPLOSION_DURATION + 1.0,
    THREE.NormalBlending
  );
  smokeParticles.userData.isSmoke = true;
  explosionEffects.push(smokeParticles);
  scene.add(smokeParticles);
  const debrisMaterial = new THREE.PointsMaterial({
    color: 0x444444,
    size: 0.2,
    transparent: true,
    opacity: 1.0,
  });
  const debrisParticles = createParticleSystem(
    DEBRIS_PARTICLES,
    position,
    null,
    null,
    null,
    DEBRIS_SPEED,
    EXPLOSION_DURATION,
    THREE.NormalBlending,
    debrisMaterial
  );
  debrisParticles.userData.isDebris = true;
  explosionEffects.push(debrisParticles);
  scene.add(debrisParticles);
}
function createParticleSystem(
  count,
  position,
  texture,
  color,
  size,
  speed,
  duration,
  blending,
  customMaterial = null
) {
  const particlesGeo = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const velocities = [];
  const startLifes = new Float32Array(count);
  const material =
    customMaterial ||
    new THREE.PointsMaterial({
      map: texture,
      color: color,
      size: size,
      blending: blending,
      transparent: true,
      opacity: 1.0,
      depthWrite: false,
      sizeAttenuation: true,
    });
  if (texture === smokeTexture) material.opacity = 0.6;
  for (let i = 0; i < count; i++) {
    const index = i * 3;
    positions[index] = position.x + (Math.random() - 0.5) * 0.1;
    positions[index + 1] = position.y + (Math.random() - 0.5) * 0.1;
    positions[index + 2] = position.z + (Math.random() - 0.5) * 0.1;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    const speedFactor = speed * (Math.random() * 0.5 + 0.5);
    const velocity = new THREE.Vector3(
      speedFactor * Math.sin(phi) * Math.cos(theta),
      speedFactor * Math.cos(phi),
      speedFactor * Math.sin(phi) * Math.sin(theta)
    );
    velocities.push(velocity);
    startLifes[i] = duration * (Math.random() * 0.3 + 0.7);
  }
  particlesGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3)
  );
  particlesGeo.setAttribute(
    "startLife",
    new THREE.BufferAttribute(startLifes, 1)
  );
  const particleSystem = new THREE.Points(particlesGeo, material);
  particleSystem.userData = {
    velocities: velocities,
    life: duration,
    elapsed: 0,
    initialSize: size,
    initialColor: color ? color.clone() : null,
  };
  return particleSystem;
}
function clearExplosion() {
  explosionEffects.forEach((system) => {
    scene.remove(
      system
    ); /* system.geometry.dispose(); system.material.dispose(); */
  });
  explosionEffects = [];
}

// --- Controles ---
function setupControls() {
  document.addEventListener("keydown", (event) => {
    keys[event.code] = true;
    if (
      [
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Space",
        "KeyA",
        "KeyD",
      ].includes(event.code)
    ) {
      event.preventDefault();
    }
    // Atirar (apenas se não estiver game over E conectado)
    if (event.code === "Space" && !isGameOver && player && socket?.connected) {
      createBullet();
    }
  });
  document.addEventListener("keyup", (event) => {
    keys[event.code] = false;
  });
}

// --- Atualizações (Loop de Animação) ---

function smoothLerp(current, target, deltaTime, factor) {
  const lerpFactor = 1.0 - Math.exp(-deltaTime * factor);
  return THREE.MathUtils.lerp(current, target, lerpFactor);
}

// Atualiza jogador LOCAL e envia estado
function updatePlayer(deltaTime) {
  if (isGameOver || !player) return; // Só atualiza se estiver vivo e inicializado

  // --- Cálculo das Taxas de Rotação Alvo (Baseado nas Teclas) ---
  targetPitchRate = 0;
  targetRollRate = 0;
  targetYawRate = 0;
  if (keys["ArrowUp"]) targetPitchRate = MAX_PITCH_RATE * CONTROL_SENSITIVITY;
  if (keys["ArrowDown"])
    targetPitchRate = -MAX_PITCH_RATE * CONTROL_SENSITIVITY;
  if (keys["ArrowLeft"]) targetRollRate = MAX_ROLL_RATE * CONTROL_SENSITIVITY;
  if (keys["ArrowRight"]) targetRollRate = -MAX_ROLL_RATE * CONTROL_SENSITIVITY;
  if (keys["KeyA"]) targetYawRate = MAX_YAW_RATE * CONTROL_SENSITIVITY;
  if (keys["KeyD"]) targetYawRate = -MAX_YAW_RATE * CONTROL_SENSITIVITY;
  // Auto-Bank
  targetRollRate -= targetYawRate * AUTO_BANK_FACTOR;
  targetRollRate = THREE.MathUtils.clamp(
    targetRollRate,
    -MAX_ROLL_RATE * CONTROL_SENSITIVITY,
    MAX_ROLL_RATE * CONTROL_SENSITIVITY
  );

  // --- Suavização das Taxas de Rotação Atuais ---
  currentPitchRate = smoothLerp(
    currentPitchRate,
    targetPitchRate,
    deltaTime,
    CONTROL_DAMPING
  );
  currentRollRate = smoothLerp(
    currentRollRate,
    targetRollRate,
    deltaTime,
    CONTROL_DAMPING
  );
  currentYawRate = smoothLerp(
    currentYawRate,
    targetYawRate,
    deltaTime,
    CONTROL_DAMPING
  );

  // --- Guardar estado anterior para verificar mudança ---
  const oldPosition = player.position.clone();
  const oldQuaternion = player.quaternion.clone();

  // --- Aplicar Rotação e Movimento ---
  player.rotateX(currentPitchRate * deltaTime);
  player.rotateZ(currentRollRate * deltaTime);
  player.rotateY(currentYawRate * deltaTime);

  const forward = new THREE.Vector3(0, 0, 1);
  forward.applyQuaternion(player.quaternion);
  const playerVelocity = forward.multiplyScalar(PLANE_SPEED);
  player.position.addScaledVector(playerVelocity, deltaTime);

  // --- Enviar atualização para o servidor APENAS se houver mudança significativa ---
  // Evita spam de mensagens se o jogador estiver parado
  const posChanged = player.position.distanceToSquared(oldPosition) > 0.0001; // Quadrado da distância para eficiência
  const rotChanged = !player.quaternion.equals(oldQuaternion); // Comparação direta de quaternions

  // Envia apenas se conectado e algo mudou
  if (
    (posChanged || rotChanged) &&
    socket &&
    socket.connected &&
    localPlayerId
  ) {
    // Enviar como objetos simples, não vetores/quaternions Three.js
    socket.emit("player_update", {
      position: {
        x: player.position.x,
        y: player.position.y,
        z: player.position.z,
      },
      rotation: {
        x: player.quaternion.x,
        y: player.quaternion.y,
        z: player.quaternion.z,
        w: player.quaternion.w,
      },
    });
  }
}

// Atualiza posição visual dos jogadores REMOTOS (Interpolação)
function updateRemotePlayers(deltaTime) {
  const interpolationFactor = 0.15; // Quão rápido alcança o alvo (0 a 1). Menor = mais suave, mais atrasado.
  const now = Date.now();
  // Tempo máximo em ms sem receber update antes de parar a interpolação.
  // Se a rede estiver lenta, pode precisar aumentar.
  const timeThreshold = 300; // ms (aumentado um pouco para testar)

  for (const id in remotePlayers) {
    const remote = remotePlayers[id];
    // Só interpola se o grupo existe, está visível e se recebeu update recentemente
    if (
      remote.group &&
      remote.group.visible &&
      now - remote.lastUpdateTime < timeThreshold
    ) {
      const currentPos = remote.group.position;
      const targetPos = remote.targetPosition;

      // *** LOG ADICIONADO ***
      // Mostra ID (4 chars), posição atual e posição alvo durante a interpolação
      // Loga apenas se a distância for significativa para evitar spam
      if (currentPos.distanceToSquared(targetPos) > 0.01) {
        // Loga se a distância > 0.1
        console.log(
          `Interpolating remote ${id.substring(
            0,
            4
          )}. Current: x=${currentPos.x.toFixed(1)}, y=${currentPos.y.toFixed(
            1
          )} -> Target: x=${targetPos.x.toFixed(1)}, y=${targetPos.y.toFixed(
            1
          )}`
        );
      }

      // Interpolar posição (Lerp)
      remote.group.position.lerp(remote.targetPosition, interpolationFactor);

      // Interpolar rotação (Slerp para Quaternions)
      remote.group.quaternion.slerp(
        remote.targetQuaternion,
        interpolationFactor
      );
    } else if (remote.group && remote.group.visible) {
      // *** LOG OPCIONAL: Sem update recente ***
      // Descomente se quiser ver quando a interpolação para por falta de updates
      // console.log(`Skipping interpolation for ${id.substring(0,4)} (no recent update). Last update: ${now - remote.lastUpdateTime}ms ago`);
    }
  }
}

// Atualiza Balas (Locais e Remotas)
function updateBullets(deltaTime) {
  const time = clock.elapsedTime;
  const serverNow = Date.now(); // Para comparar com startTime do servidor

  // Balas locais
  for (let i = bullets.length - 1; i >= 0; i--) {
    const bullet = bullets[i];
    bullet.position.addScaledVector(bullet.userData.velocity, deltaTime);
    // Verifica tempo de vida local
    if (time - bullet.userData.startTime > bullet.userData.life) {
      scene.remove(bullet);
      bullets.splice(i, 1);
    }
    // TODO: Colisão Bala Local -> Jogador Remoto (apenas visual ou notificar servidor?)
  }

  // Balas remotas
  for (const id in remoteBullets) {
    const bullet = remoteBullets[id];
    const timeElapsed = (serverNow - bullet.startTime) / 1000.0; // Tempo em segundos desde criação no servidor

    if (timeElapsed < bullet.life && timeElapsed >= 0) {
      // Movimento simples incremental (idealmente calcular posição exata P = P0 + V*t)
      bullet.mesh.position.addScaledVector(bullet.velocity, deltaTime);

      // Colisão Bala Remota -> Jogador Local
      if (
        player &&
        !isGameOver &&
        bullet.mesh.position.distanceTo(player.position) < 1.5
      ) {
        // Limiar de colisão
        console.log(`Colisão detectada localmente com bala remota ${id}!`);
        // Idealmente, a colisão REAL é confirmada pelo servidor.
        // Aqui, podemos apenas mostrar um efeito visual rápido ou ignorar.
        // Notificar o servidor que FOMOS atingidos?
        // socket.emit('hit_by_bullet', { bulletId: id });
        // Por ora, vamos deixar o servidor tratar colisões (se implementado lá)
        // Poderíamos remover a bala localmente para feedback
        removeRemoteBullet(id);
      }
    } else {
      // Se o tempo de vida expirou localmente (antes da notificação do servidor, talvez)
      removeRemoteBullet(id);
    }
  }
}

// Atualiza Animação da Explosão (igual à versão anterior)
function updateExplosion(deltaTime) {
  for (let i = explosionEffects.length - 1; i >= 0; i--) {
    const system = explosionEffects[i];
    const data = system.userData;
    const attributes = system.geometry.attributes;
    const positions = attributes.position.array;
    const velocities = data.velocities;
    const startLifes = attributes.startLife.array;
    data.elapsed += deltaTime;
    const systemLifeRatio = Math.max(0, 1.0 - data.elapsed / data.life);
    let particlesStillAlive = false;
    for (let j = 0; j < velocities.length; j++) {
      const particleLife = startLifes[j];
      const particleLifeRatio = Math.max(0, 1.0 - data.elapsed / particleLife);
      if (particleLifeRatio > 0) {
        particlesStillAlive = true;
        const index = j * 3;
        positions[index] += velocities[j].x * deltaTime;
        positions[index + 1] += velocities[j].y * deltaTime;
        positions[index + 2] += velocities[j].z * deltaTime;
        if (data.isDebris || data.isSmoke)
          velocities[j].y -= GRAVITY * deltaTime * (data.isDebris ? 1.0 : 0.3);
        if (data.isSmoke) {
          velocities[j].x += (Math.random() - 0.5) * 0.5 * deltaTime;
          velocities[j].z += (Math.random() - 0.5) * 0.5 * deltaTime;
          velocities[j].y += 0.8 * deltaTime;
        }
        velocities[j].multiplyScalar(1.0 - deltaTime * 0.2);
        if (data.isFireball)
          system.material.opacity = particleLifeRatio * particleLifeRatio;
        else if (data.isSmoke) {
          system.material.size = data.initialSize * (1.0 + data.elapsed * 0.5);
          system.material.opacity = particleLifeRatio * 0.6;
        } else if (data.isDebris) system.material.opacity = particleLifeRatio;
      }
    }
    attributes.position.needsUpdate = true;
    if (systemLifeRatio <= 0 || !particlesStillAlive) {
      scene.remove(system);
      explosionEffects.splice(i, 1);
    }
  }
}

// Atualiza Câmera (segue jogador local)
function updateCamera(deltaTime) {
  if (!player) return; // Não fazer nada se não temos jogador local

  const desiredPosition = new THREE.Vector3();
  desiredPosition.copy(CAMERA_OFFSET);
  desiredPosition.applyQuaternion(player.quaternion);
  desiredPosition.add(player.position);
  const lerpFactor = 1.0 - Math.exp(-deltaTime * 5.0);
  camera.position.lerp(desiredPosition, lerpFactor);

  const lookAtPosition = new THREE.Vector3(0, 1, 10); // Olhar ligeiramente acima e à frente
  lookAtPosition.applyQuaternion(player.quaternion);
  lookAtPosition.add(player.position);
  camera.lookAt(lookAtPosition);
}

// --- Colisões Locais ---
function checkCollisions() {
  // Verifica apenas colisão do jogador LOCAL com o chão
  if (isGameOver || !player || !socket || !localPlayerId) return;

  if (player.position.y <= GROUND_LEVEL + COLLISION_THRESHOLD) {
    // Evita enviar múltiplas notificações de colisão
    if (!player.userData.collisionSent) {
      console.log(
        "Colisão local com o chão detectada. Notificando servidor..."
      );
      player.userData.collisionSent = true; // Marca que já enviamos
      socket.emit("player_collision", { type: "ground" });

      // Feedback imediato: para controle local e mostra mensagem
      isGameOver = true;
      messageElement.innerText = "Colisão! Aguardando servidor...";
      messageElement.style.display = "block";
      // Não esconder o avião ou criar explosão aqui, esperar confirmação do servidor
    }
  }
}

// --- Tratamento de Explosão (Invocado pelo Servidor via 'player_exploded') ---
function handlePlayerExplosion(playerId, serverPosition) {
  const position = new THREE.Vector3(
    serverPosition.x,
    serverPosition.y,
    serverPosition.z
  );
  position.y = GROUND_LEVEL + 0.2; // Posição da explosão ligeiramente acima do chão

  if (playerId === localPlayerId) {
    console.log("Confirmação de minha explosão recebida!");
    if (!isGameOver) isGameOver = true; // Garante estado
    player.visible = false; // Esconde nosso avião
    infoElement.style.display = "none"; // Esconde info normal
    messageElement.innerText = "BOOM!"; // Mensagem final
    messageElement.style.display = "block";
    createExplosion(position); // Cria efeito visual local
    // O reset virá do evento 'player_reset'
  } else if (remotePlayers[playerId]) {
    console.log(`Jogador remoto ${playerId} explodiu!`);
    remotePlayers[playerId].group.visible = false; // Esconde avião remoto
    createExplosion(position); // Cria efeito visual na posição dele
    // O respawn será tratado por 'player_respawned'
  } else {
    console.warn(
      `Recebida explosão para jogador desconhecido ou já removido: ${playerId}`
    );
  }
}

// --- Reset Game (Invocado pelo Servidor via 'player_reset') ---
function resetGame(serverPosition, serverRotation) {
  console.log("Resetando jogo localmente por ordem do servidor...");
  isGameOver = false;
  messageElement.style.display = "none";
  infoElement.style.display = "block"; // Mostra info novamente

  // Limpar balas LOCAIS
  bullets.forEach((bullet) => scene.remove(bullet));
  bullets = [];
  // Balas remotas são gerenciadas pelo servidor

  clearExplosion(); // Limpa efeitos de explosão

  if (player) {
    // Define posição e rotação EXATAS do servidor
    player.position.set(serverPosition.x, serverPosition.y, serverPosition.z);
    player.quaternion.set(
      serverRotation.x,
      serverRotation.y,
      serverRotation.z,
      serverRotation.w
    );
    player.visible = true;
    player.userData.collisionSent = false; // Reseta flag de colisão
  } else {
    // Caso raro: jogador foi removido localmente mas servidor mandou resetar? Recria.
    console.warn("Jogador local não existia durante o reset. Recriando.");
    createPlayer(
      localPlayerId,
      {
        id: localPlayerId,
        position: serverPosition,
        rotation: serverRotation,
        isDead: false,
      },
      true
    );
  }

  resetPlayerState(); // Reseta taxas de rotação locais
  keys = {}; // Limpa estado das teclas pressionadas
}

// Reseta apenas o estado interno do controle local
function resetPlayerState() {
  targetPitchRate = targetRollRate = targetYawRate = 0;
  currentPitchRate = currentRollRate = currentYawRate = 0;
  if (player) player.userData.collisionSent = false; // Garante reset da flag
}

// --- Loop de Animação Principal ---
function animate() {
  requestAnimationFrame(animate);
  const deltaTime = clock.getDelta();

  // Atualiza jogador local (movimento e envio de dados) - Apenas se inicializado
  if (localPlayerId && player) {
    if (!isGameOver) {
      // Só permite controle e checagem de colisão se não estiver morto/game over
      updatePlayer(deltaTime);
      checkCollisions();
    }
    // Câmera segue mesmo se estiver morto (para ver explosão/respawn)
    updateCamera(deltaTime);
  }

  // Interpola jogadores remotos
  updateRemotePlayers(deltaTime);

  // Atualiza balas (locais e remotas)
  updateBullets(deltaTime);

  // Atualiza efeitos de explosão
  updateExplosion(deltaTime);

  renderer.render(scene, camera); // Renderiza a cena
}

// --- Redimensionamento da Janela ---
function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener("resize", onWindowResize);

// --- Iniciar o Jogo ---
init();
