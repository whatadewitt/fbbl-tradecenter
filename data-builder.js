const LEAGUE_KEY = process.env.LEAGUE_KEY;

const request = require("request");

const YahooFantasy = require("yahoo-fantasy");
const yf = new YahooFantasy(
  process.env.YAPP_CLIENT_ID,
  process.env.YAPP_CLIENT_SECRET
);

const AWS = require("aws-sdk");
const s3 = new AWS.S3();

const buildRosters = async () => {
  const { draft_results } = await yf.league.draft_results(LEAGUE_KEY);
  const { transactions } = await yf.league.transactions(LEAGUE_KEY);
  const [{ teams }] = await yf.teams.leagues(LEAGUE_KEY, "roster");

  const player_cache = {};

  draft_results.forEach((pick) => {
    player_cache[pick.player_key] = { draft_cost: parseInt(pick.cost, 10) };
  });

  transactions.forEach(({ players, type, faab_bid, status }) => {
    if ("successful" === status && /add/i.test(type)) {
      const player = players.filter(
        (player) => "team" === player.transaction.destination_type
      )[0];

      if (!player_cache[player.player_key]) {
        player_cache[player.player_key] = {
          ...player_cache[player.player_key],
          free_agent_cost: parseInt(faab_bid, 10),
        };
      }
    }
  });
  
  // 2023 changes
  // player_cache["412.p.11377"].draft_cost = 1; // luis p
  // player_cache["412.p.9557"].draft_cost = 23; // javier b

  const data = teams.map(({ team_key, name, roster }) => {
    const players = roster.map((p) => {
      return {
        name: p.name.full,
        key: p.player_key,
        drafted: player_cache[p.player_key].draft_cost ? true : false,
        cost:
          player_cache[p.player_key].draft_cost ||
          player_cache[p.player_key].free_agent_cost,
      };
    });

    return {
      name,
      key: team_key,
      players,
    };
  });

  const params = {
    Bucket: process.env.AWS_S3_BUCKET_NAME,
    Key: process.env.AWS_S3_BUCKET_KEY,
    Body: JSON.stringify(data),
    ACL: "public-read",
  };

  s3.putObject(params, function (err, data) {
    if (err) {
      // TODO: email about IAM issues
      console.error(err);
    } else {
      console.log("Successfully uploaded data");
    }

    process.exit(0);
  });
};

buildRosters();
