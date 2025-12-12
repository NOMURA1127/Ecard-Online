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

// 1試合で使うデッキ
function createDeck(role) {
  if (role === "emperor") {
    return { emperor: 1, citizen: 4 };
  } else {
    return { slave: 1, citizen: 4 };
  }
}

function flipRole(role) {
  return role === "emperor" ? "slave" : "emperor";
}

// roomId -> 状態
const rooms = {};

/**
 * 指定ルームで新しい試合（1戦）を開始する
 * gameIndex: 0〜11（12戦）
 */
function startGame(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.matchFinished) return;
  if (room.gameIndex >= 12) return;

  room.gameOver = false;
  room.round = { moves: {} };
  room.turnIndex = 0; // この試合の中でのターン（最大5）

  const segment = Math.floor(room.gameIndex / 3); // 0〜3（3戦ごと）

  room.players.forEach((p) => {
    // 開始時の役割 baseRole を元に、3戦ごとに入れ替え
    const role = segment % 2 === 0 ? p.baseRole : flipRole(p.baseRole);
    p.role = role;
    p.deck = createDeck(role);

    const payload = {
      roomId,
      gameNo: room.gameIndex + 1,
      totalGames: 12,
      role,
      deck: p.deck,
      players: room.players.map((pl) => ({
        name: pl.name,
        baseRole: pl.baseRole
      }))
    };

    const eventName = room.gameIndex === 0 ? "joined" : "new_game";
    io.to(p.id).emit(eventName, payload);
  });

  // 何戦目か
  io.to(roomId).emit("game_counter", {
    gameNo: room.gameIndex + 1,
    totalGames: 12
  });

  // スコア（星取表）も送る
  io.to(roomId).emit("score_update", {
    scores: room.players.map((p) => ({
      name: p.name,
      wins: room.score[p.id] || 0
    }))
  });
}

io.on("connection", (socket) => {
  console.log("connected:", socket.id);

  // 部屋に入る
  socket.on("join_room", ({ roomId, password, name, roleChoice }) => {
    if (!roomId || !password || !name) {
      socket.emit("error_msg", "部屋番号・パスワード・名前を全部入れてね");
      return;
    }

    // 新規ルームなら作成
    if (!rooms[roomId]) {
      rooms[roomId] = {
        password,
        players: [],
        round: { moves: {} },
        gameIndex: 0,      // 0〜11
        turnIndex: 0,      // その試合内のターン
        gameOver: false,
        matchFinished: false,
        score: {},         // 総ポイント
        gameHistory: []    // 追加：試合ごとの履歴
      };
    }

    const room = rooms[roomId];

    // パスワードチェック
    if (room.password !== password) {
      socket.emit("error_msg", "パスワードが違います");
      return;
    }

    // 2人まで
    if (room.players.length >= 2) {
      socket.emit("error_msg", "この部屋は満員です（2人まで）");
      return;
    }

    // すでに使われている baseRole を確認
    const usedBaseRoles = room.players.map((p) => p.baseRole);

    let baseRole = null;
    if (roleChoice === "emperor" || roleChoice === "slave") {
      if (usedBaseRoles.includes(roleChoice)) {
        socket.emit(
          "error_msg",
          `その役割（${roleChoice === "emperor" ? "皇帝側" : "奴隷側"}）はすでに埋まっています`
        );
        return;
      }
      baseRole = roleChoice;
    } else {
      // おまかせ：空いている方
      if (!usedBaseRoles.includes("emperor")) {
        baseRole = "emperor";
      } else if (!usedBaseRoles.includes("slave")) {
        baseRole = "slave";
      } else {
        socket.emit("error_msg", "この部屋は役割が埋まっています");
        return;
      }
    }

    const player = {
      id: socket.id,
      name,
      baseRole, // 開始時の役割
      role: baseRole,
      deck: createDeck(baseRole)
    };

    room.players.push(player);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;

    // スコア初期化
    room.score[player.id] = 0;

    // プレイヤー一覧
    io.to(roomId).emit("player_list", {
      players: room.players.map((p) => ({
        name: p.name,
        baseRole: p.baseRole
      }))
    });

    // まだ1人目なら待機
    if (room.players.length === 1) {
      socket.emit("waiting", {
        message: "相手を待っています…（もう1人が入ると試合開始）",
        baseRole
      });
      return;
    }

    // 2人そろったのでマッチ開始（12戦）
    room.gameIndex = 0;
    room.matchFinished = false;
    room.gameOver = false;
    room.turnIndex = 0;

    room.players.forEach((p) => {
      room.score[p.id] = 0;
    });

    startGame(roomId);
  });

  // カードを出す
  socket.on("play_card", (card) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];

    if (room.matchFinished) {
      socket.emit("error_msg", "このマッチはすでに12戦終了しています。");
      return;
    }

    if (room.gameOver) {
      socket.emit("error_msg", "この試合はすでに決着済みです。次の試合開始を待ってください。");
      return;
    }

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    // 残り枚数チェック
    if (!player.deck[card] || player.deck[card] <= 0) {
      socket.emit("error_msg", "そのカードはもうありません！");
      return;
    }

    // カード消費
    player.deck[card]--;
    socket.emit("update_deck", player.deck);

    // ターン内の出し札登録
    if (!room.round) room.round = { moves: {} };
    room.round.moves[socket.id] = card;

    const ids = Object.keys(room.round.moves);
    if (ids.length < 2) {
      // もう片方待ち
      return;
    }

    const id1 = ids[0];
    const id2 = ids[1];
    const card1 = room.round.moves[id1];
    const card2 = room.round.moves[id2];

    // まず、市民 vs 市民 なら「流れ」扱いで試合続行
    if (card1 === "citizen" && card2 === "citizen") {
      io.to(id1).emit("no_decision", {
        yourCard: card1,
        oppCard: card2
      });
      io.to(id2).emit("no_decision", {
        yourCard: card2,
        oppCard: card1
      });

      room.turnIndex += 1;
      room.round.moves = {};

      // 一応セーフティ：5ターン越えたら引き分け扱いで試合終了
      if (room.turnIndex >= 5) {
        room.gameOver = true;
        // 引き分け → スコア変動なし
        io.to(roomId).emit("round_result", {
          result: "draw",
          yourCard: null,
          oppCard: null
        });
        finishGameAndMaybeStartNext(roomId);
      }
      return;
    }

    // ここに来た時点で皇帝 or 奴隷が含まれていて、試合決着
    const result = judge(card1, card2); // 0:引き分け(ほぼ出ない), 1:id1勝ち, -1:id2勝ち

    sendResult(id1, id2, card1, card2, result);

    room.gameOver = true;

    // 勝った側に1勝
    if (result === 1 || result === -1) {
      const winnerId = result === 1 ? id1 : id2;
      room.score[winnerId] = (room.score[winnerId] || 0) + 1;
    }

    if (result === 1 || result === -1) {
      const winnerId = result === 1 ? id1 : id2;
      const winner = room.players.find(p => p.id === winnerId);

      // 皇帝勝ち → 1pt / 奴隷勝ち → 5pt
      const point = winner.role === "emperor" ? 1 : 5;

      room.score[winnerId] = (room.score[winnerId] || 0) + point;

      // 履歴記録
      room.gameHistory.push({
        gameNo: room.gameIndex + 1,
        winnerName: winner.name,
        winnerRole: winner.role,
        point
      });

      // 全員へ履歴更新送信
      io.to(roomId).emit("history_update", room.gameHistory);
    }


    // 試合終了処理（次の試合へ or マッチ終了）
    finishGameAndMaybeStartNext(roomId);
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];
    room.players = room.players.filter((p) => p.id !== socket.id);
    delete room.score[socket.id];

    io.to(roomId).emit("opponent_left");

    if (room.players.length === 0) {
      delete rooms[roomId];
    }
  });
});

/**
 * 1試合終了後、gameIndex を進めて
 * 12戦終わっていればマッチ終了、そうでなければ次の試合開始
 */
function finishGameAndMaybeStartNext(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  // スコア更新通知（星取表）
  io.to(roomId).emit("score_update", {
    scores: room.players.map((p) => ({
      name: p.name,
      wins: room.score[p.id] || 0
    }))
  });

  room.gameIndex += 1;

  if (room.gameIndex >= 12) {
    room.matchFinished = true;

    const [pA, pB] = room.players;
    const scoreA = room.score[pA.id] || 0;
    const scoreB = room.score[pB.id] || 0;

    let winnerName = null;
    if (scoreA > scoreB) winnerName = pA.name;
    else if (scoreB > scoreA) winnerName = pB.name;

    io.to(roomId).emit("match_over", {
      totalGames: 12,
      scores: [
        { name: pA.name, wins: scoreA },
        { name: pB.name, wins: scoreB }
      ],
      winnerName
    });
  } else {
    startGame(roomId);
  }
}

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

// Eカード判定
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
