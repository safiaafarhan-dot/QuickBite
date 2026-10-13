'use strict';

/**
 * The QuickBite kitchen menu — the single source of truth.
 *
 * `server/db.js` seeds the database from this list, and `scripts/fetch-images.js`
 * uses `image_query` to pull a matching openly-licensed photo for each dish.
 *
 * `tags` feed the content-based half of the recommender in `server/ai/recommend.js`,
 * so they describe how a dish *tastes and eats*, not just what it is.
 */

const MENU = [
  /* ---------------------------------------------------------------- Starters */
  {
    name: 'Garlic Bread with Cheese',
    slug: 'garlic-bread',
    description: 'Wood-oven focaccia brushed with garlic butter and blanketed in molten mozzarella.',
    price: 220, category: 'starters', cuisine: 'italian',
    is_veg: 1, is_popular: 1, rating: 4.5, prep_minutes: 12, spice_level: 0, calories: 410,
    tags: 'cheesy,baked,garlic,shareable,bread,comfort',
    image_query: 'garlic bread cheese',
  },
  {
    name: 'Crispy Chicken Wings',
    slug: 'chicken-wings',
    description: 'Twice-fried wings tossed in a sticky chilli-honey glaze with a cooling dip.',
    price: 340, category: 'starters', cuisine: 'american',
    is_veg: 0, is_popular: 1, rating: 4.6, prep_minutes: 18, spice_level: 2, calories: 560,
    tags: 'fried,spicy,chicken,sticky,shareable,finger-food',
    image_file: 'Chicken wings at Bar Loosister.jpg',
    image_query: 'buffalo chicken wings plate',
  },
  {
    name: 'Paneer Tikka',
    slug: 'paneer-tikka',
    description: 'Yoghurt-and-spice marinated paneer charred in the tandoor with peppers and onion.',
    price: 320, category: 'starters', cuisine: 'indian',
    is_veg: 1, is_popular: 1, rating: 4.7, prep_minutes: 20, spice_level: 2, calories: 390,
    tags: 'grilled,smoky,paneer,tandoori,protein,spiced',
    image_file: 'Tandoori Paneer Tikka.jpg',
    image_query: 'paneer tikka tandoori',
  },
  {
    name: 'Veg Spring Rolls',
    slug: 'spring-rolls',
    description: 'Shatteringly crisp rolls packed with julienned vegetables and glass noodles.',
    price: 240, category: 'starters', cuisine: 'asian',
    is_veg: 1, is_popular: 0, rating: 4.2, prep_minutes: 14, spice_level: 1, calories: 320,
    tags: 'fried,crispy,vegetables,light,shareable,finger-food',
    image_query: 'spring rolls fried',
  },

  /* ------------------------------------------------------------------- Pizza */
  {
    name: 'Classic Margherita Pizza',
    slug: 'margherita-pizza',
    description: 'Hand-stretched base, San Marzano tomato, fior di latte and torn basil.',
    price: 450, category: 'pizza', cuisine: 'italian',
    is_veg: 1, is_popular: 1, rating: 4.7, prep_minutes: 18, spice_level: 0, calories: 760,
    tags: 'cheesy,baked,tomato,classic,comfort,shareable',
    image_file: 'Pizza Margherita ().JPG',
    image_query: 'margherita pizza',
  },
  {
    name: 'Pepperoni Pizza',
    slug: 'pepperoni-pizza',
    description: 'Cupping pepperoni over mozzarella, finished with oregano and chilli oil.',
    price: 620, category: 'pizza', cuisine: 'italian',
    is_veg: 0, is_popular: 1, rating: 4.8, prep_minutes: 20, spice_level: 1, calories: 940,
    tags: 'cheesy,baked,meaty,classic,comfort,shareable',
    image_file: 'Pizza Tradición Napolitana.jpg',
    image_query: 'pepperoni pizza',
  },
  {
    name: 'Farmhouse Veggie Pizza',
    slug: 'farmhouse-pizza',
    description: 'Mushroom, capsicum, sweetcorn, red onion and olive on a herbed tomato base.',
    price: 540, category: 'pizza', cuisine: 'italian',
    is_veg: 1, is_popular: 0, rating: 4.4, prep_minutes: 20, spice_level: 0, calories: 820,
    tags: 'cheesy,baked,vegetables,loaded,comfort,shareable',
    image_query: 'pizza vegetariana',
  },

  /* ------------------------------------------------------------------- Pasta */
  {
    name: 'Spaghetti Carbonara',
    slug: 'carbonara',
    description: 'Silky egg-and-pecorino sauce with crisp guanciale and cracked black pepper.',
    price: 520, category: 'pasta', cuisine: 'italian',
    is_veg: 0, is_popular: 1, rating: 4.6, prep_minutes: 22, spice_level: 0, calories: 880,
    tags: 'creamy,rich,pork,classic,comfort,eggy',
    image_file: 'Spaghetti Carbonara 2015.jpg',
    image_query: 'spaghetti carbonara',
  },
  {
    name: 'Penne Arrabbiata',
    slug: 'arrabbiata',
    description: 'Fiery tomato sugo with garlic, red chilli and a slick of good olive oil.',
    price: 380, category: 'pasta', cuisine: 'italian',
    is_veg: 1, is_popular: 0, rating: 4.4, prep_minutes: 20, spice_level: 3, calories: 640,
    tags: 'spicy,tomato,garlic,light,classic',
    image_query: 'penne pasta tomato sauce',
  },
  {
    name: 'Creamy Alfredo Pasta',
    slug: 'alfredo',
    description: 'Fettuccine folded through butter, cream and aged parmesan until glossy.',
    price: 460, category: 'pasta', cuisine: 'italian',
    is_veg: 1, is_popular: 1, rating: 4.5, prep_minutes: 18, spice_level: 0, calories: 900,
    tags: 'creamy,rich,cheesy,comfort,mild',
    image_file: 'Chicken fettuccine alfredo.JPG',
    image_query: 'pasta alfredo',
  },
  {
    name: 'Lasagna al Forno',
    slug: 'lasagna',
    description: 'Slow-simmered ragù layered with béchamel and pasta, baked until bubbling.',
    price: 560, category: 'pasta', cuisine: 'italian',
    is_veg: 0, is_popular: 0, rating: 4.7, prep_minutes: 28, spice_level: 0, calories: 980,
    tags: 'baked,cheesy,meaty,rich,comfort,hearty',
    image_file: 'Lasagne - stonesoup.jpg',
    image_query: 'lasagna slice plate',
  },

  /* ----------------------------------------------------------------- Burgers */
  {
    name: 'Veggie Burger',
    slug: 'veggie-burger',
    description: 'Charred vegetable-and-bean patty, smoked cheddar and house burger sauce.',
    price: 400, category: 'burgers', cuisine: 'american',
    is_veg: 1, is_popular: 1, rating: 4.5, prep_minutes: 15, spice_level: 1, calories: 680,
    tags: 'grilled,cheesy,handheld,comfort,vegetables',
    image_query: 'vegetarian burger', image_avoid: 'king,chain',
  },
  {
    name: 'Classic Chicken Burger',
    slug: 'chicken-burger',
    description: 'Buttermilk-brined chicken thigh, crisp lettuce and pickles in a brioche bun.',
    price: 460, category: 'burgers', cuisine: 'american',
    is_veg: 0, is_popular: 1, rating: 4.6, prep_minutes: 16, spice_level: 1, calories: 790,
    tags: 'fried,chicken,handheld,comfort,crispy',
    image_file: 'Fried chicken burger .jpg',
    image_query: 'fried chicken burger', image_avoid: 'original,chain',
  },
  {
    name: 'Smoky BBQ Chicken Burger',
    slug: 'bbq-burger',
    description: 'Double chicken patty, smoked cheese, bacon jam and bourbon barbecue sauce.',
    price: 640, category: 'burgers', cuisine: 'american',
    is_veg: 0, is_popular: 0, rating: 4.7, prep_minutes: 18, spice_level: 2, calories: 1020,
    tags: 'grilled,smoky,cheesy,meaty,handheld,indulgent',
    image_query: 'cheeseburger',
  },

  /* ------------------------------------------------------------ Indian mains */
  {
    name: 'Chicken Biryani',
    slug: 'chicken-biryani',
    description: 'Dum-cooked basmati layered with marinated chicken, saffron and fried onion.',
    price: 720, category: 'mains', cuisine: 'indian',
    is_veg: 0, is_popular: 1, rating: 4.8, prep_minutes: 30, spice_level: 3, calories: 920,
    tags: 'rice,spiced,aromatic,chicken,hearty,festive',
    image_file: 'Dum Biryani Plate.jpg',
    image_query: 'biryani plate',
  },
  {
    name: 'Hyderabadi Veg Biryani',
    slug: 'veg-biryani',
    description: 'Seasonal vegetables and paneer steamed under a saffron-scented basmati crust.',
    price: 520, category: 'mains', cuisine: 'indian',
    is_veg: 1, is_popular: 0, rating: 4.4, prep_minutes: 28, spice_level: 3, calories: 760,
    tags: 'rice,spiced,aromatic,vegetables,hearty,festive',
    image_file: 'Vegetable Biryani IMG 001.jpg',
    image_query: 'vegetable biryani',
  },
  {
    name: 'Butter Chicken',
    slug: 'butter-chicken',
    description: 'Tandoori chicken simmered in a velvety tomato-and-cashew gravy with cream.',
    price: 680, category: 'mains', cuisine: 'indian',
    is_veg: 0, is_popular: 1, rating: 4.9, prep_minutes: 25, spice_level: 2, calories: 870,
    tags: 'creamy,rich,tomato,chicken,comfort,mild-spice',
    image_file: 'Butter Chicken, City Grill Kottayam.jpg',
    image_query: 'butter chicken murgh makhani',
  },
  {
    name: 'Paneer Butter Masala',
    slug: 'paneer-butter-masala',
    description: 'Soft paneer in a glossy makhani gravy finished with kasuri methi and butter.',
    price: 520, category: 'mains', cuisine: 'indian',
    is_veg: 1, is_popular: 1, rating: 4.6, prep_minutes: 22, spice_level: 2, calories: 740,
    tags: 'creamy,rich,tomato,paneer,comfort,mild-spice',
    image_query: 'paneer curry', image_avoid: 'palak,spinach,saag,tikka,kadai',
  },
  {
    name: 'Dal Makhani',
    slug: 'dal-makhani',
    description: 'Black lentils simmered overnight with butter and cream until silken.',
    price: 380, category: 'mains', cuisine: 'indian',
    is_veg: 1, is_popular: 0, rating: 4.5, prep_minutes: 20, spice_level: 1, calories: 520,
    tags: 'creamy,lentils,slow-cooked,comfort,hearty,mild-spice',
    image_file: 'Dal Makhani..JPG',
    image_query: 'dal makhani',
  },

  /* -------------------------------------------------------------------- Asian */
  {
    name: 'Hakka Noodles',
    slug: 'hakka-noodles',
    description: 'Wok-tossed noodles with shredded vegetables, soy and a lick of chilli.',
    price: 340, category: 'asian', cuisine: 'asian',
    is_veg: 1, is_popular: 0, rating: 4.3, prep_minutes: 16, spice_level: 2, calories: 620,
    tags: 'noodles,wok,savoury,vegetables,quick',
    image_file: 'Veg Noodles.JPG',
    image_query: 'vegetable noodles stir fry',
  },
  {
    name: 'Chicken Fried Rice',
    slug: 'chicken-fried-rice',
    description: 'Day-old rice seared hard with egg, spring onion and shredded chicken.',
    price: 420, category: 'asian', cuisine: 'asian',
    is_veg: 0, is_popular: 1, rating: 4.4, prep_minutes: 15, spice_level: 1, calories: 700,
    tags: 'rice,wok,savoury,chicken,quick,eggy',
    image_file: 'Chicken fried rice - Stir Fry by CK 2023-12-02.jpg',
    image_query: 'chicken fried rice',
  },
  {
    name: 'Pad See Ew',
    slug: 'pad-thai',
    description: 'Wide rice noodles seared in dark soy with chicken, egg and Chinese broccoli.',
    price: 480, category: 'asian', cuisine: 'thai',
    is_veg: 0, is_popular: 1, rating: 4.6, prep_minutes: 18, spice_level: 2, calories: 680,
    tags: 'noodles,wok,savoury,smoky,soy,quick',
    image_file: 'Pad Ciew Noodles with Chicken - Little Thai 2024-06-14.jpg',
    image_query: 'phat thai noodles', image_avoid: 'ingredients,raw,hor kai,omelette',
  },

  /* ---------------------------------------------------------------- Desserts */
  {
    name: 'Vanilla Bean Ice Cream',
    slug: 'vanilla-ice-cream',
    description: 'Slow-churned Madagascar vanilla, scooped to order.',
    price: 310, category: 'desserts', cuisine: 'continental',
    is_veg: 1, is_popular: 0, rating: 4.3, prep_minutes: 5, spice_level: 0, calories: 330,
    tags: 'sweet,cold,creamy,vanilla,simple',
    image_query: 'ice cream scoops bowl', image_avoid: 'fruit salad,jamun,sundae,cone',
  },
  {
    name: 'Chocolate Lava Cake',
    slug: 'lava-cake',
    description: 'Warm dark-chocolate pudding with a molten centre and vanilla ice cream.',
    price: 350, category: 'desserts', cuisine: 'continental',
    is_veg: 1, is_popular: 1, rating: 4.8, prep_minutes: 14, spice_level: 0, calories: 560,
    tags: 'sweet,chocolate,warm,indulgent,baked',
    image_query: 'chocolate lava cake molten',
  },
  {
    name: 'Gulab Jamun',
    slug: 'gulab-jamun',
    description: 'Khoya dumplings soaked warm in cardamom-and-rose sugar syrup.',
    price: 220, category: 'desserts', cuisine: 'indian',
    is_veg: 1, is_popular: 1, rating: 4.6, prep_minutes: 8, spice_level: 0, calories: 420,
    tags: 'sweet,syrupy,warm,traditional,cardamom',
    image_query: 'gulab jamun',
  },
  {
    name: 'Classic Tiramisu',
    slug: 'tiramisu',
    description: 'Espresso-soaked savoiardi under whipped mascarpone and bitter cocoa.',
    price: 390, category: 'desserts', cuisine: 'italian',
    is_veg: 1, is_popular: 0, rating: 4.7, prep_minutes: 10, spice_level: 0, calories: 480,
    tags: 'sweet,coffee,creamy,chilled,indulgent',
    image_file: 'Tiramisu dessert.jpg',
    image_query: 'tiramisu dessert',
  },

  /* --------------------------------------------------------------- Beverages */
  {
    name: 'Fresh Orange Juice',
    slug: 'orange-juice',
    description: 'Cold-pressed Nagpur oranges, nothing added, poured over ice.',
    price: 160, category: 'beverages', cuisine: 'continental',
    is_veg: 1, is_popular: 0, rating: 4.4, prep_minutes: 4, spice_level: 0, calories: 110,
    tags: 'cold,refreshing,citrus,light,fruity',
    image_file: 'Orange juice without any fruits.jpg',
    image_query: 'orange juice', image_avoid: 'breakfast,cereal,banana,waffle,buffet,oranges,carton',
  },
  {
    name: 'Mango Lassi',
    slug: 'mango-lassi',
    description: 'Alphonso mango blended with thick curd, a pinch of cardamom and ice.',
    price: 180, category: 'beverages', cuisine: 'indian',
    is_veg: 1, is_popular: 1, rating: 4.7, prep_minutes: 5, spice_level: 0, calories: 260,
    tags: 'cold,creamy,sweet,fruity,yoghurt',
    image_query: 'mango lassi glass',
  },
  {
    name: 'Cold Brew Coffee',
    slug: 'cold-brew',
    description: 'Single-origin beans steeped eighteen hours, poured over ice.',
    price: 200, category: 'beverages', cuisine: 'continental',
    is_veg: 1, is_popular: 0, rating: 4.4, prep_minutes: 4, spice_level: 0, calories: 15,
    tags: 'cold,coffee,bitter,refreshing,caffeine',
    image_query: 'iced coffee glass',
  },
  {
    name: 'Masala Chai',
    slug: 'masala-chai',
    description: 'Assam leaf boiled with ginger, cardamom and clove, finished with milk.',
    price: 90, category: 'beverages', cuisine: 'indian',
    is_veg: 1, is_popular: 1, rating: 4.5, prep_minutes: 6, spice_level: 1, calories: 120,
    tags: 'hot,spiced,milky,comfort,traditional,caffeine',
    image_file: 'Masala Tea 2.jpg',
    image_query: 'masala chai tea cup',
  },
];

/** Human-facing labels for the category chips, in menu order. */
const CATEGORY_ORDER = ['starters', 'pizza', 'pasta', 'burgers', 'mains', 'asian', 'desserts', 'beverages'];

const CATEGORY_LABELS = {
  starters: 'Starters',
  pizza: 'Pizza',
  pasta: 'Pasta',
  burgers: 'Burgers',
  mains: 'Indian mains',
  asian: 'Asian',
  desserts: 'Desserts',
  beverages: 'Drinks',
};

module.exports = { MENU, CATEGORY_ORDER, CATEGORY_LABELS };
