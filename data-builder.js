const LEAGUE_KEY = process.env.LEAGUE_ID;
console.log(`LK: ${LEAGUE_KEY}`);
console.log(process.env);

const redis = require("redis");
const request = require("request");
const { promisify } = require("util");

const YahooFantasy = require("yahoo-fantasy");
const yf = new YahooFantasy(
  process.env.YAPP_CLIENT_ID,
  process.env.YAPP_CLIENT_SECRET
);

const AWS = require("aws-sdk");
const s3 = new AWS.S3();

const client = redis.createClient(process.env.REDIS_URL);

const getSync = promisify(client.get).bind(client);

client.on("connect", async () => {
  const token = await getSync("accessToken");
  const refresh = await getSync("refreshToken");

  yf.setUserToken(token);

  buildRosters(refresh);
});

const buildRosters = async (refreshToken) => {
  try {
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

        player_cache[player.player_key] = {
          ...player_cache[player.player_key],
          free_agent_cost: parseInt(faab_bid, 10),
        };
      }
    });

    const data = teams.map(({ team_key, name, roster }) => {
      const players = roster.map((p) => {
        return {
          name: p.name.full,
          key: p.player_key,
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
  } catch (e) {
    const reason = e.description;

    if (reason && /token_expired/i.test(reason)) {
      const options = {
        url: "https://api.login.yahoo.com/oauth2/get_token",
        method: "post",
        json: true,
        form: {
          client_id: process.env.YAPP_CLIENT_ID,
          client_secret: process.env.YAPP_CLIENT_SECRET,
          redirect_uri: "oob",
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        },
      };

      request(options, function (error, response, body) {
        if (error) {
          console.error("Couldn't renew token...");
          // TODO: email about token
          process.exit(0);
        }

        console.info("updating access and refresh token");
        client.set("accessToken", body.access_token);
        client.set("refreshToken", body.refresh_token);

        yf.setUserToken(body.access_token);

        buildRosters(body.refresh_token);
      });
    } else {
      console.error(e);
      // TODO: email about unknown issues
    }
  }
};
