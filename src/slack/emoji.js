'use strict';

/**
 * The shortcodes Slack messages actually use, mapped to the unicode character
 * they stand for. Not every emoji Slack knows — just the handful hundred that
 * turn up in ordinary chat — so a shortcode nobody recognised is left exactly
 * as typed, colons and underscores both, rather than half-eaten by markup
 * rules that do not know it is there.
 */
const SHORTCODES = {
  // smileys
  grinning: '😀', smiley: '😃', smile: '😄', grin: '😁', laughing: '😆', satisfied: '😆',
  sweat_smile: '😅', rofl: '🤣', joy: '😂', slightly_smiling_face: '🙂', upside_down_face: '🙃',
  wink: '😉', blush: '😊', innocent: '😇', smiling_face_with_three_hearts: '🥰', heart_eyes: '😍',
  star_struck: '🤩', kissing_heart: '😘', kissing: '😗', kissing_smiling_eyes: '😙', kissing_closed_eyes: '😚',
  yum: '😋', stuck_out_tongue: '😛', stuck_out_tongue_winking_eye: '😜', zany_face: '🤪',
  stuck_out_tongue_closed_eyes: '😝', money_mouth_face: '🤑', hugs: '🤗', hand_over_mouth: '🤭',
  shushing_face: '🤫', thinking: '🤔', zipper_mouth_face: '🤐', raised_eyebrow: '🤨',
  neutral_face: '😐', expressionless: '😑', no_mouth: '😶', smirk: '😏', unamused: '😒',
  roll_eyes: '🙄', grimacing: '😬', lying_face: '🤥', relieved: '😌', pensive: '😔',
  sleepy: '😪', drooling_face: '🤤', sleeping: '😴', mask: '😷', face_with_thermometer: '🤒',
  face_with_head_bandage: '🤕', nauseated_face: '🤢', vomiting_face: '🤮', sneezing_face: '🤧',
  hot_face: '🥵', cold_face: '🥶', woozy_face: '🥴', dizzy_face: '😵', exploding_head: '🤯',
  cowboy_hat_face: '🤠', partying_face: '🥳', sunglasses: '😎', nerd_face: '🤓', monocle_face: '🧐',
  confused: '😕', worried: '😟', slightly_frowning_face: '🙁', frowning_face: '☹️', open_mouth: '😮',
  hushed: '😯', astonished: '😲', flushed: '😳', pleading_face: '🥺', frowning: '😦',
  anguished: '😧', fearful: '😨', cold_sweat: '😰', disappointed_relieved: '😥', cry: '😢',
  sob: '😭', scream: '😱', confounded: '😖', persevere: '😣', disappointed: '😞',
  sweat: '😓', weary: '😩', tired_face: '😫', yawning_face: '🥱', triumph: '😤', rage: '😡',
  pout: '😡', angry: '😠', cursing_face: '🤬', smiling_imp: '😈', imp: '👿', skull: '💀',
  skull_and_crossbones: '☠️', hankey: '💩', poop: '💩', shit: '💩', clown_face: '🤡', ogre: '👹',
  goblin: '👺', ghost: '👻', alien: '👽', robot_face: '🤖', smiley_cat: '😺', smile_cat: '😸',
  joy_cat: '😹', heart_eyes_cat: '😻', smirk_cat: '😼', kissing_cat: '😽', scream_cat: '🙀',
  crying_cat_face: '😿', pouting_cat: '😾',

  // gestures / hands
  wave: '👋', raised_back_of_hand: '🤚', raised_hand_with_fingers_splayed: '🖐️', hand: '✋',
  spock_hand: '🖖', ok_hand: '👌', pinched_fingers: '🤌', pinching_hand: '🤏', v: '✌️',
  crossed_fingers: '🤞', love_you_gesture: '🤟', metal: '🤘', call_me_hand: '🤙',
  point_left: '👈', point_right: '👉', point_up_2: '👆', middle_finger: '🖕', fu: '🖕',
  point_down: '👇', point_up: '☝️', thumbsup: '👍', '+1': '👍', thumbsdown: '👎', '-1': '👎',
  fist_raised: '✊', fist: '✊', fist_oncoming: '👊', facepunch: '👊', punch: '👊',
  fist_left: '🤛', fist_right: '🤜', clap: '👏', raised_hands: '🙌', open_hands: '👐',
  palms_up_together: '🤲', handshake: '🤝', pray: '🙏', writing_hand: '✍️', nail_care: '💅',
  selfie: '🤳', muscle: '💪',

  // hearts / symbols
  heart: '❤️', orange_heart: '🧡', yellow_heart: '💛', green_heart: '💚', blue_heart: '💙',
  purple_heart: '💜', black_heart: '🖤', white_heart: '🤍', brown_heart: '🤎', broken_heart: '💔',
  heavy_heart_exclamation: '❣️', two_hearts: '💕', sparkling_heart: '💖', heartpulse: '💗',
  heartbeat: '💓', revolving_hearts: '💞', cupid: '💘', gift_heart: '💝', heart_decoration: '💟',
  sparkles: '✨', star: '⭐', star2: '🌟', dizzy: '💫', boom: '💥', collision: '💥',
  fire: '🔥', tada: '🎉', confetti_ball: '🎊', balloon: '🎈', '100': '💯', zzz: '💤',
  dash: '💨', sweat_drops: '💦', eyes: '👀', eye: '👁️', speech_balloon: '💬',
  thought_balloon: '💭', exclamation: '❗', question: '❓', warning: '⚠️', white_check_mark: '✅',
  heavy_check_mark: '✔️', x: '❌', no_entry: '⛔', no_entry_sign: '🚫', recycle: '♻️',
  heavy_plus_sign: '➕', heavy_minus_sign: '➖', heavy_division_sign: '➗', infinity: '♾️',
  bulb: '💡', gear: '⚙️', hourglass: '⌛', hourglass_flowing_sand: '⏳', alarm_clock: '⏰',
  stopwatch: '⏱️', calendar: '📅', date: '📅', pushpin: '📌', round_pushpin: '📍',
  link: '🔗', paperclip: '📎', lock: '🔒', unlock: '🔓', key: '🔑', mag: '🔍', mag_right: '🔎',
  email: '✉️', envelope: '✉️', inbox_tray: '📥', outbox_tray: '📤', package: '📦',
  memo: '📝', pencil2: '✏️', clipboard: '📋', chart_with_upwards_trend: '📈',
  chart_with_downwards_trend: '📉', bar_chart: '📊', computer: '💻', iphone: '📱',
  telephone_receiver: '📞', bell: '🔔', no_bell: '🔕', loudspeaker: '📢', mega: '📣',

  // people / reactions often used in threads
  raised_hand: '✋', wave2: '👋', bow: '🙇', man_bowing: '🙇‍♂️', woman_bowing: '🙇‍♀️',
  shrug: '🤷', man_shrugging: '🤷‍♂️', woman_shrugging: '🤷‍♀️', facepalm: '🤦',
  man_facepalming: '🤦‍♂️', woman_facepalming: '🤦‍♀️', raised_hand_with_fingers_splayed2: '🖐️',

  // animals / nature
  dog: '🐶', cat: '🐱', mouse: '🐭', hamster: '🐹', rabbit: '🐰', fox_face: '🦊', bear: '🐻',
  panda_face: '🐼', koala: '🐨', tiger: '🐯', lion: '🦁', cow: '🐮', pig: '🐷', frog: '🐸',
  monkey_face: '🐵', monkey: '🐒', chicken: '🐔', penguin: '🐧', bird: '🐦', baby_chick: '🐤',
  duck: '🦆', eagle: '🦅', owl: '🦉', bat: '🦇', wolf: '🐺', horse: '🐴', unicorn: '🦄',
  bee: '🐝', bug: '🐛', butterfly: '🦋', snail: '🐌', turtle: '🐢', snake: '🐍', octopus: '🐙',
  fish: '🐟', dolphin: '🐬', whale: '🐳', shark: '🦈', crab: '🦀', rainbow: '🌈', sun_with_face: '🌞',
  sunny: '☀️', partly_sunny: '⛅', cloud: '☁️', rain_cloud: '🌧️', snowflake: '❄️', snowman: '⛄',
  zap: '⚡', umbrella: '☂️', droplet: '💧', ocean: '🌊', four_leaf_clover: '🍀', maple_leaf: '🍁',

  // food
  coffee: '☕', tea: '🍵', beer: '🍺', beers: '🍻', wine_glass: '🍷', cocktail: '🍸',
  tropical_drink: '🍹', pizza: '🍕', hamburger: '🍔', fries: '🍟', hotdog: '🌭', taco: '🌮',
  burrito: '🌯', ramen: '🍜', sushi: '🍣', bento: '🍱', doughnut: '🍩', cookie: '🍪',
  cake: '🍰', birthday: '🎂', chocolate_bar: '🍫', candy: '🍬', popcorn: '🍿', apple: '🍎',
  banana: '🍌', grapes: '🍇', watermelon: '🍉', strawberry: '🍓', lemon: '🍋', peach: '🍑',

  // objects / activities
  rocket: '🚀', airplane: '✈️', car: '🚗', bike: '🚲', office: '🏢', house: '🏠',
  tada2: '🎉', trophy: '🏆', medal: '🏅', soccer: '⚽', basketball: '🏀', checkered_flag: '🏁',
  video_game: '🎮', art: '🎨', musical_note: '🎵', notes: '🎶', microphone: '🎤',
  headphones: '🎧', camera: '📷', movie_camera: '🎥', tv: '📺', book: '📖', books: '📚',
  newspaper: '📰', moneybag: '💰', dollar: '💵', credit_card: '💳', gift: '🎁',
  wrench: '🔧', hammer: '🔨', nut_and_bolt: '🔩', bomb: '💣', shield: '🛡️', crown: '👑',
  gem: '💎', ring: '💍',

  // flags occasionally seen
  checkered_flag2: '🏁', triangular_flag_on_post: '🚩', white_flag: '🏳️', black_flag: '🏴'
};

// A few names Slack treats as synonyms of another shortcode.
const ALIASES = {
  simple_smile: 'slightly_smiling_face',
  thumbsup_all: 'thumbsup',
  ok: 'ok_hand',
  heavy_tick: 'heavy_check_mark',
  check: 'white_check_mark'
};

/** One shortcode, including its optional `::skin-tone-N` suffix which this never shows. */
const SHORTCODE = /:([a-zA-Z0-9_+-]+):(?::skin-tone-\d:)?/g;

function lookup(name) {
  if (Object.prototype.hasOwnProperty.call(SHORTCODES, name)) return SHORTCODES[name];
  const alias = ALIASES[name];
  if (alias && Object.prototype.hasOwnProperty.call(SHORTCODES, alias)) return SHORTCODES[alias];
  return null;
}

/**
 * Replace every shortcode this recognises with its unicode character. A
 * shortcode it does not know is left exactly as it was typed — colons,
 * underscores and any skin-tone suffix included — so later markup rules have
 * nothing of ours to misread.
 *
 * @param {string} text
 * @returns {string}
 */
function applyEmoji(text) {
  if (!text) return text == null ? '' : text;
  return String(text).replace(SHORTCODE, (full, name) => {
    const emoji = lookup(name);
    return emoji == null ? full : emoji;
  });
}

module.exports = { applyEmoji, SHORTCODES };
