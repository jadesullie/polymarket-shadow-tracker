const fs = require('fs');
const path = require('path');

// Load data once
let journalData = null;
function getData() {
  if (!journalData) {
    journalData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'journal-daily.json'), 'utf8'));
  }
  return journalData;
}

module.exports = (req, res) => {
  const data = getData();
  const { date, from, to } = req.query;
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300');
  
  if (date) {
    // Single day
    res.json({ date, events: data[date] || [] });
  } else if (from && to) {
    // Date range — return day summaries (not full events, too large)
    const result = {};
    for (const [d, events] of Object.entries(data)) {
      if (d >= from && d <= to) {
        result[d] = {
          buys: events.filter(e => e.t === 'B').length,
          sells: events.filter(e => e.t === 'S').length,
          redeems: events.filter(e => e.t === 'R').length,
          total: events.length,
          volume: Math.round(events.reduce((s, e) => s + e.sz, 0))
        };
      }
    }
    res.json(result);
  } else {
    // Return available dates
    const dates = Object.keys(data).sort();
    res.json({ dates, total: dates.length, from: dates[0], to: dates[dates.length-1] });
  }
};
