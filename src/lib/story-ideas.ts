// Story-idea bank for the Fayyaz page (English only).
// Every idea follows the Fayyaz standing rules:
// - CAPTURED not CREATED: realistic phone-style footage, no cinematic moves.
// - Max 2–3 actions per 10 seconds; one locked space, same props throughout.
// - No-face rule: first-person POV or the subject filmed from behind / off
//   screen — the "star" is a pet, an object, or hands, never a visible face.
// - Comedy comes from BEHAVIOR, not impossible physics.
// - Every reel must give the viewer something meaningful (a small lesson,
//   a relatable truth, or a clever twist) — never pure empty entertainment.
// - Universal and culture-free: no language-specific jokes, no local
//   references; English captions and hashtags only.
// Prompts are single-scene video prompts for grok-imagine-video-1-5-preview
// (default 8 seconds). Add new ideas by appending to STORY_IDEAS — the
// daily pick rotates through the list in order, so a new idea is used the
// next day it comes up in the rotation.

export interface StoryIdea {
  id: string;
  title: string;
  /** Single-scene video prompt sent to the video model. */
  prompt: string;
  /** Short English caption (without hashtags). */
  caption: string;
  /** English-only hashtags. */
  hashtags: string[];
}

export const DEFAULT_HASHTAGS = ["#FunnyReels", "#AIVideo", "#Comedy", "#ViralReels"];

export const STORY_IDEAS: StoryIdea[] = [
  {
    id: "charger-thief",
    title: "The Charger Thief",
    prompt:
      "Realistic phone video, first-person view from a phone lying on a kitchen table: a curious orange cat slowly drags the charging cable off the table with one paw, pauses and looks straight at the camera, then proudly carries the cable away across the floor. Natural daylight, ordinary kitchen, no people on screen.",
    caption: "He pays no rent but he takes the charger. 😹",
    hashtags: ["#FunnyCats", "#CatComedy", "#FunnyReels", "#AIVideo", "#CatsOfInstagram"],
  },
  {
    id: "pigeon-bus-stop",
    title: "The Pigeon at the Bus Stop",
    prompt:
      "Realistic street video from a fixed phone angle: a grey pigeon stands in line with three waiting commuters at a bus stop, shuffles forward one step every time the line moves, then hops onto the bus step when the doors open. The commuters do not react. Morning light, ordinary city street, no faces visible.",
    caption: "He waits for the bus like the rest of us. Even pigeons have somewhere to be. 🚌",
    hashtags: ["#FunnyAnimals", "#Pigeon", "#FunnyReels", "#AIVideo", "#Comedy"],
  },
  {
    id: "sleepy-guard-chair",
    title: "The Sleepy Guard's Chair",
    prompt:
      "Realistic office video, fixed camera: a security guard in uniform dozes off in his rolling chair, the chair slowly rolls backwards across the empty lobby on its own, and he wakes up confused in a completely different corner. Quiet lobby, fluorescent light, filmed from behind so no face is visible.",
    caption: "The chair had other plans. 😴",
    hashtags: ["#FunnyVideos", "#OfficeHumor", "#FunnyReels", "#AIVideo", "#Relatable"],
  },
  {
    id: "umbrella-refused",
    title: "The Umbrella That Refused",
    prompt:
      "Realistic rainy street video from a first-person view: a hand opens an umbrella, a gust of wind flips it inside out, the hand calmly flips it back, and the wind flips it again — the hand gives up and just walks on holding the broken umbrella like a flag. Grey rainy day, no faces visible.",
    caption: "Some battles you just lose. The wind always wins. ☔",
    hashtags: ["#RainyDay", "#FunnyReels", "#AIVideo", "#Relatable", "#Comedy"],
  },
  {
    id: "fridge-guard-dog",
    title: "The Dog Who Guards the Fridge",
    prompt:
      "Realistic home video, fixed kitchen angle: a small dog lies in front of the fridge, and every time a hand reaches for the fridge door the dog lifts one eyebrow and sighs loudly without moving. The hand gives up and walks away. Warm kitchen light, no people on screen, only hands.",
    caption: "The fridge is closed. The dog has spoken. 🐶",
    hashtags: ["#FunnyDogs", "#DogComedy", "#FunnyReels", "#AIVideo", "#DogsOfInstagram"],
  },
  {
    id: "elevator-every-floor",
    title: "The Elevator That Stops at Every Floor",
    prompt:
      "Realistic elevator video from a first-person view: the elevator doors open on every single floor, nobody gets in, the doors close, and the next floor lights up. On the last floor a cat is waiting, walks in calmly and presses the button with its paw. Plain elevator interior, no faces visible.",
    caption: "Every floor. No passengers. Until the real boss arrived. 🐱",
    hashtags: ["#FunnyReels", "#CatComedy", "#AIVideo", "#Comedy", "#Relatable"],
  },
  {
    id: "last-cookie",
    title: "The Last Cookie",
    prompt:
      "Realistic kitchen video, close-up on a cookie jar: two hands reach for the last cookie at the exact same moment, both stop, both point at each other politely, then both pull back and the cookie stays. The jar lid slowly slides closed on its own. Warm light, hands only, no faces.",
    caption: "Politeness level: nobody gets the cookie. 🍪",
    hashtags: ["#FunnyReels", "#Relatable", "#AIVideo", "#Comedy", "#FoodHumor"],
  },
  {
    id: "roomba-escape",
    title: "The Roomba Escape Artist",
    prompt:
      "Realistic living-room video, low fixed angle: a robot vacuum quietly pushes a rug, climbs over a shoe, bumps the door open and rolls toward the hallway — then a cat sitting in the hallway calmly blocks the way with one paw and the vacuum turns around. Afternoon light, ordinary home.",
    caption: "Escape plan: failed. The cat is security. 🤖🐱",
    hashtags: ["#FunnyCats", "#RobotVacuum", "#FunnyReels", "#AIVideo", "#Comedy"],
  },
  {
    id: "fish-watches-tv",
    title: "The Fish Who Watches TV",
    prompt:
      "Realistic living-room video: a goldfish bowl sits next to a TV, and the goldfish swims to the side of the bowl closest to the screen and follows the moving pictures back and forth. The TV shows a nature documentary about the ocean. Soft evening light, no people on screen.",
    caption: "He has seen the ocean. On TV. He is not impressed. 🐠",
    hashtags: ["#FunnyAnimals", "#Goldfish", "#FunnyReels", "#AIVideo", "#Comedy"],
  },
  {
    id: "alarm-clock-revenge",
    title: "The Alarm Clock's Revenge",
    prompt:
      "Realistic bedroom video, first-person view from the bed: a hand reaches out and hits snooze on an alarm clock, the clock slides off the nightstand, lands on the floor and keeps ringing from under the bed. The hand gives up and pulls the blanket over. Soft morning light, hands only.",
    caption: "You can snooze the clock. You cannot snooze the day. ⏰",
    hashtags: ["#MorningHumor", "#Relatable", "#FunnyReels", "#AIVideo", "#Comedy"],
  },
  {
    id: "plant-window",
    title: "The Plant That Grew Into the Window",
    prompt:
      "Realistic sunny apartment video, fixed angle on a windowsill: a small potted plant has grown so tall its leaves press against the window glass, and a hand gently moves the pot, but the plant leans back toward the sun within seconds. A cat watches from the sofa, unimpressed. Bright daylight.",
    caption: "The plant knows what it wants. Sunlight. Always sunlight. 🌱",
    hashtags: ["#Plants", "#FunnyReels", "#AIVideo", "#Relatable", "#Comedy"],
  },
  {
    id: "grandma-plant-vs-cat",
    title: "Grandma's Plant vs. the Cat",
    prompt:
      "Realistic living-room video, fixed angle: a cat creeps toward a potted plant, looks around, takes one bite of a leaf, freezes when a slipper appears at the edge of the frame, and slowly backs away pretending nothing happened. Warm home light, no people on screen.",
    caption: "Caught red-pawed. He denies everything. 🌿",
    hashtags: ["#FunnyCats", "#CatComedy", "#FunnyReels", "#AIVideo", "#CatsOfInstagram"],
  },
];

/** Deterministic daily pick: one idea per day, rotating through the bank. */
export function pickStoryIdea(date = new Date()): StoryIdea {
  const dayNumber = Math.floor(date.getTime() / 86_400_000);
  return STORY_IDEAS[dayNumber % STORY_IDEAS.length];
}

/** Short English caption + English-only hashtags, ready to post. */
export function buildCaption(idea: Pick<StoryIdea, "caption" | "hashtags">): string {
  return `${idea.caption}\n\n${idea.hashtags.join(" ")}`;
}
