const fs = require('fs');

const SAMPLE_CONFIG_FILE_NAME = 'mempool-config.sample.json';
const CONFIG_FILE_NAME = 'mempool-config.json';

const settings = {};
const args = process.argv.slice(2);

let sourcePath = SAMPLE_CONFIG_FILE_NAME;
let destinationPath = CONFIG_FILE_NAME;

function castedValue(value) {
  if (String(value).toLowerCase() === 'true') {
    value = true;
  } else if (String(value).toLowerCase() === 'false') {
    value = false;
  } else if (!isNaN(value) && String(value).trim() !== '') {
    value = Number(value);
  }
  try {
    const decoded = JSON.parse(value);
    if (decoded instanceof Array) {
      value = decoded;
    }
  } catch (e) {
  }
  return value;
}

function updateConfig(names, value, node) {
  const name = names.shift();
  if (Object.hasOwn(node, name)) {
    if (typeof node[name] === 'object' && !(node[name] instanceof Array)) {
      updateConfig(names, value, node[name]);
    } else {
      node[name] = value;
    }
  }
}

args.forEach(setting => {
  setting = setting.split('=');
  if (setting[0] === 'SOURCE_CONFIG_FILE') {
    sourcePath = setting[1];
  } else if (setting[0] === 'DEST_CONFIG_FILE') {
    destinationPath = setting[1];
  } else {
    const key = setting[0];
    const value = setting[1];
    settings[key] = castedValue(value);
  }
});

const config = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'));

for (const key in settings) {
  if (Object.hasOwn(settings, key)) {
    updateConfig(key.split('.'), settings[key], config);
  }
}

fs.writeFileSync(destinationPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
