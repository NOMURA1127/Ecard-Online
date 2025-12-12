// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static("public"));

// 初期デッキ
function createDeck(role) {
  if (role === "emperor") {
    return { emperor: 1, citizen: 4 };
  } else {
    return { slave: 1, citizen: 4 };
  }
}

const rooms = {}; // roomId -> { password, players, round, gameOver }

io.on("connection", (socket) => {
  console.log("connected:", socket.id);

  socket.on("join_room", ({ roomId, password, name, roleChoice }) => {
    if (!roomId || !password || !name) {
      socket.emit("error_msg", "部屋番号・パスワード・名前を全部入れてね");
      return;
    }

    if (!rooms[roomId]) {
      rooms[roomId] = {
        password,
        players: [],
        round: { moves: {} },
        gameOver: false
      };
    }

    const room = rooms[roomId];

    if (room.password !== password) {
      socket.emit("error_msg", "パスワードが違います");
      return;
    }

    if (room.players.length >= 2) {
      socket.emit("error_msg", "この部屋は満員です（2人まで）");
      return;
    }

    // すでに使われている役割を確認
    const usedRoles = room.players.map((p) => p.role);

    let role = null;
    if (roleChoice === "emperor" || roleChoice === "slave") {
      // 希望役割がすでに埋まっていたらNG
      if (usedRoles.includes(roleChoice)) {
        socket.emit(
          "error_msg",
          `その役割（${roleChoice === "emperor" ? "皇帝側" : "奴隷側"}）はすでに埋まっています`
        );
        return;
      }
      role = roleChoice;
    } else {
      // おまかせ（空いている方に入れる）
      if (!usedRoles.includes("emperor")) {
        role = "emperor";
      } else if (!usedRoles.includes("slave")) {
        role = "slave";
      } else {
        socket.emit("error_msg", "この部屋は役割が埋まっています");
        return;
      }
    }

    const player = {
      id: socket.id,
      name,
      role,
      deck: createDeck(role)
    };

    room.players.push(player);

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = role;
    socket.data.name = name;

    socket.emit("joined", {
      roomId,
      role,
      name,
      deck: player.deck,
      players: room.players.map((p) => ({ name: p.name, role: p.role }))
    });

    io.to(roomId).emit("player_list", {
      players: room.players.map((p) => ({ name: p.name, role: p.role }))
    });

    // 新規対戦用フラグリセット
    room.gameOver = false;
    room.round.moves = {};

    if (room.players.length === 2) {
      io.to(roomId).emit("game_ready");
    }
  });

  // カードを出す
  socket.on("play_card", (card) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];

    // すでに決着がついていたら受け付けない
    if (room.gameOver) {
      socket.emit("error_msg", "この対戦はすでに終了しています。新しい部屋で遊んでね。");
      return;
    }

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    // 残り枚数チェック
    if (!player.deck[card] || player.deck[card] <= 0) {
      socket.emit("error_msg", "そのカードはもうありません！");
      return;
    }

    // カードを消費
    player.deck[card]--;

    // 手札更新を本人に返す
    socket.emit("update_deck", player.deck);

    // ラウンド情報更新
    if (!room.round) room.round = { moves: {} };
    room.round.moves[socket.id] = card;

    const ids = Object.keys(room.round.moves);
    if (ids.length < 2) return; // もう片方待ち

    const id1 = ids[0];
    const id2 = ids[1];
    const card1 = room.round.moves[id1];
    const card2 = room.round.moves[id2];

    const result = judge(card1, card2); // 0:引き分け, 1:id1勝ち, -1:id2勝ち

    // 結果通知
    sendResult(id1, id2, card1, card2, result);

    // 非引き分け = 決着 → ゲーム終了
    if (result === 1 || result === -1) {
      room.gameOver = true;

      const winnerId = result === 1 ? id1 : id2;
      const winner = room.players.find((p) => p.id === winnerId);

      io.to(roomId).emit("game_over", {
        winnerName: winner ? winner.name : null,
        winnerRole: winner ? winner.role : null
      });
    }

    // 次ラウンド用にリセット（引き分けなら続行用）
    room.round.moves = {};
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];
    room.players = room.players.filter((p) => p.id !== socket.id);

    io.to(roomId).emit("opponent_left");

    if (room.players.length === 0) {
      delete rooms[roomId];
    }
  });
});

function sendResult(id1, id2, c1, c2, result) {
  if (result === 0) {
    io.to(id1).emit("round_result", { result: "draw", yourCard: c1, oppCard: c2 });
    io.to(id2).emit("round_result", { result: "draw", yourCard: c2, oppCard: c1 });
  } else if (result === 1) {
    io.to(id1).emit("round_result", { result: "win", yourCard: c1, oppCard: c2 });
    io.to(id2).emit("round_result", { result: "lose", yourCard: c2, oppCard: c1 });
  } else {
    io.to(id1).emit("round_result", { result: "lose", yourCard: c1, oppCard: c2 });
    io.to(id2).emit("round_result", { result: "win", yourCard: c2, oppCard: c1 });
  }
}

// 判定ロジック（Eカード）
function judge(a, b) {
  if (a === b) return 0;
  if (a === "emperor" && b === "citizen") return 1;
  if (a === "citizen" && b === "slave") return 1;
  if (a === "slave" && b === "emperor") return 1;

  if (b === "emperor" && a === "citizen") return -1;
  if (b === "citizen" && a === "slave") return -1;
  if (b === "slave" && a === "emperor") return -1;

  return 0;
}

const PORT = 3000;
server.listen(PORT, () => console.log(`Server running http://localhost:${PORT}`));
