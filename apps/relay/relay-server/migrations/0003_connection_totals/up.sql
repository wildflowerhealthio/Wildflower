-- How many connections to the relay's front had each outcome, per UTC hour.
-- `hour` is the hour's start in Unix epoch seconds; `outcome` is one of the
-- relay's outcome names (`ok`, `tunnel_down`, `unknown_tunnel`, …); `count`
-- is how many. No tunnel names, addresses or other identifiers: nothing here
-- says who connected or to which tunnel. The relay adds its counts every
-- minute and deletes rows older than 30 days.
CREATE TABLE connection_totals (
    hour INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (hour, outcome)
) STRICT;
