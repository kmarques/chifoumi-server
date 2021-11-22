require("dotenv").config();
const express = require("express");
const app = express();
const cors = require("cors");
const {v4: uuidv4} = require("uuid");
const {checkTurnWinner, checkMatchWinner} = require("./lib/chifoumi");
const NotificationCenter = require("./lib/notificationCenter");
const createToken = require("./lib/jwt").createToken;
const verifyJwt = require("./middlewares/verifyJwt");
require("./lib/mongo");
const User = require("./models/user");
const Match = require("./models/match");
const turnValidator = require("./middlewares/turnValidator");

app.use(express.json());
app.use(cors());

app.post("/login", async function(req, res) {
  let user = await User.findOne({username: req.body.username});
  if (!user) {
    user = new User({
      ...req.body,
      _id: uuidv4(),
    });
    user = await user.save();
  }
  res.json({token: await createToken(user)});
});

app.post("/matches", verifyJwt(), async function(req, res) {
  let event = {};
  if (
    await Match.findOne({
      "user1._id": req.user._id,
      "user2": null,
    })
  ) {
    return res.status(400).json({match: "You already have a match"});
  }

  let match = await Match.findOne({
    "user1._id": {$ne: req.user._id},
    "user2": null,
  });
  if (!match) {
    match = new Match({
      user1: req.user,
      user2: null,
      turns: [],
    });
    event.type = "PLAYER1_JOIN";
    event.payload = {
      user: req.user.username,
    };
  } else {
    match.user2 = req.user;
    event.type = "PLAYER2_JOIN";
    event.payload = {
      user: req.user.username,
    };
  }
  event.matchId = match._id;
  match = await match.save();
  res.status(201).json(match);
  NotificationCenter.notify(event);
  if (match.user2) {
    event = {
      type: "NEW_TURN",
      matchId: match._id,
      payload: {
        turnId: 1,
      },
    };
    NotificationCenter.notify(event);
  }
});
app.get("/matches", verifyJwt(), async function(req, res) {
  const match = await Match.find({
    $or: [{"user1._id": req.user._id}, {"user2._id": req.user._id}],
    winner: {$exists: true},
  });
  if (match) res.json(match);
});
app.get("/matches/:id", verifyJwt(), async (req, res) => {
  const match = await Match.findOne({
    _id: req.params.id,
    $or: [{"user1._id": req.user._id}, {"user2._id": req.user._id}],
    winner: {$exists: true},
  });
  if (match) res.json(match);
  else res.sendStatus(404);
});
app.post(
    "/matches/:id/turns/:idTurn",
    verifyJwt(),
    turnValidator,
    async function(req, res) {
      const idTurn = parseInt(req.params.idTurn);
      const match = req.match;
      const turn = req.turn;
      const isPlayer1 = match.user1._id === req.user._id;
      turn[isPlayer1 ? "user1" : "user2"] = req.body.move;
      match.turns[idTurn - 1] = turn;
      if (turn.user1 && turn.user2) {
        turn.winner = checkTurnWinner(turn);
      }
      await match.save();
      res.sendStatus(202);
      NotificationCenter.notify({
        type: isPlayer1 ? "PLAYER1_MOVED" : "PLAYER2_MOVED",
        matchId: match._id,
        payload: {
          turn: idTurn,
        },
      });
      if (turn.user1 && turn.user2) {
        NotificationCenter.notify({
          type: "TURN_ENDED",
          matchId: match._id,
          payload: {
            newTurnId: idTurn + 1,
            winner: checkTurnWinner(turn),
          },
        });

        if (match.turns.length === 3) {
          match.winner = checkMatchWinner(match);
          await match.save();
          NotificationCenter.notify({
            type: "MATCH_ENDED",
            matchId: match._id,
            payload: {
              winner: (match.winner && match.winner.username) || "draw",
            },
          });
        }
      }
    },
);

app.get("/matches/:id/subscribe", verifyJwt(), function(request, response) {
  const clientId = request.user._id;

  const newClient = {
    id: clientId,
    matchId: request.params.id,
    response,
  };

  NotificationCenter.addClient(newClient).push(newClient);

  request.on("close", () => {
    console.log(`${clientId} Connection closed`);
    NotificationCenter.removeClient(newClient);
  });
});

module.exports = app;