// Applied once per database, only when there are no existing family meals.
const starterMeals = [
  [
    "Tacos",
    "Build your own with seasoned beef or black beans, lettuce, cheese, salsa, and tortillas."
  ],
  [
    "Spaghetti and Meatballs",
    "Serve with marinara, a green salad, and garlic bread; use beef or turkey meatballs."
  ],
  [
    "Grilled Chicken",
    "Pair with roasted potatoes and broccoli; season simply with lemon and herbs."
  ],
  [
    "Burgers",
    "Beef, turkey, or bean patties with favorite toppings, oven fries, and veggie sticks."
  ],
  [
    "Chicken Stir-Fry",
    "Toss chicken and colorful vegetables in a mild ginger-soy sauce; serve over rice."
  ],
  [
    "Homemade Pizza",
    "Use ready-made dough and let everyone choose cheese, vegetables, or pepperoni."
  ],
  [
    "Baked Salmon",
    "Serve lemon-baked salmon with rice and green beans."
  ],
  [
    "Chicken Fajitas",
    "Sizzle chicken, peppers, and onions; serve with warm tortillas and avocado."
  ],
  [
    "Baked Ziti",
    "Bake pasta with marinara, ricotta, and mozzarella; add spinach and a side salad."
  ],
  [
    "Pulled Pork Sandwiches",
    "Slow-cook pork with mild barbecue sauce; serve on buns with slaw and corn."
  ],
  [
    "Chicken Caesar Wraps",
    "Wrap cooked chicken, romaine, Parmesan, and Caesar dressing in tortillas; add fruit."
  ],
  [
    "Beef or Chicken Rice Bowls",
    "Top rice with beef or chicken, cucumber, carrots, and a favorite mild sauce."
  ],
  [
    "Breakfast for Dinner",
    "Scrambled eggs, pancakes, fresh fruit, and breakfast potatoes."
  ],
  [
    "Chili",
    "Make a mild beef-and-bean or all-bean chili; serve with cornbread and cheese."
  ],
  [
    "Cheese and Bean Quesadillas",
    "Fill tortillas with cheese and black beans; serve with salsa, avocado, and corn."
  ]
];
const starterMealsVersion = "family-dinners-v1";

const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
async function ensureSchema(db){await db.batch([
db.prepare("CREATE TABLE IF NOT EXISTS meals (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,notes TEXT DEFAULT '',recipe_url TEXT DEFAULT '',suggested_by TEXT DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
db.prepare("CREATE TABLE IF NOT EXISTS ratings (id INTEGER PRIMARY KEY AUTOINCREMENT,meal_id INTEGER NOT NULL,member TEXT NOT NULL,rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),comment TEXT DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(meal_id,member))"),
db.prepare("CREATE TABLE IF NOT EXISTS meal_votes (id INTEGER PRIMARY KEY AUTOINCREMENT,meal_id INTEGER NOT NULL,member TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(meal_id,member))"),
db.prepare("CREATE TABLE IF NOT EXISTS app_seeds (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
db.prepare("CREATE TABLE IF NOT EXISTS weekly_plan (plan_date TEXT PRIMARY KEY,meal_id INTEGER,note TEXT DEFAULT '',updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
]);
// D1 batches are transactional. Keep the empty-table check, all 15 inserts,
// and the marker together so simultaneous first requests cannot seed twice.
// Record the marker for existing databases too; never replace family content.
await db.batch([
  db.prepare(`
    WITH starter_meals(name, notes) AS (
      VALUES ${starterMeals.map(() => "(?, ?)").join(", ")}
    )
    INSERT INTO meals (name, notes)
    SELECT name, notes FROM starter_meals
    WHERE NOT EXISTS (SELECT 1 FROM meals)
      AND NOT EXISTS (SELECT 1 FROM app_seeds WHERE name = ?)
  `).bind(...starterMeals.flat(), starterMealsVersion),
  db.prepare("INSERT OR IGNORE INTO app_seeds (name) VALUES (?)").bind(starterMealsVersion)
]);
}
const body=async r=>{try{return await r.json()}catch{return {}}};
export default{async fetch(request,env){
const url=new URL(request.url);if(!url.pathname.startsWith("/api/"))return env.ASSETS.fetch(request);
if(!env.DB)return json({error:"Database is not configured yet."},503);
if(!env.FAMILY_PIN)return json({error:"Family PIN is not configured yet.",setupRequired:true},503);
if(request.headers.get("x-family-pin")!==env.FAMILY_PIN)return json({error:"Incorrect family PIN."},401);
await ensureSchema(env.DB);const method=request.method;
if(url.pathname==="/api/summary"&&method==="GET"){const meals=await env.DB.prepare("SELECT m.*,ROUND(AVG(r.rating),1) average_rating,COUNT(DISTINCT r.id) rating_count,COUNT(DISTINCT v.id) vote_count FROM meals m LEFT JOIN ratings r ON r.meal_id=m.id LEFT JOIN meal_votes v ON v.meal_id=m.id GROUP BY m.id ORDER BY COALESCE(AVG(r.rating),0) DESC,m.created_at DESC").all();const ratings=await env.DB.prepare("SELECT * FROM ratings ORDER BY created_at DESC").all();const votes=await env.DB.prepare("SELECT * FROM meal_votes").all();const plan=await env.DB.prepare("SELECT p.plan_date,p.note,p.meal_id,m.name meal_name FROM weekly_plan p LEFT JOIN meals m ON m.id=p.meal_id ORDER BY p.plan_date").all();return json({meals:meals.results,ratings:ratings.results,votes:votes.results,plan:plan.results})}
if(url.pathname==="/api/meals"&&method==="POST"){const b=await body(request),name=String(b.name||"").trim();if(!name)return json({error:"Meal name is required."},400);const x=await env.DB.prepare("INSERT INTO meals (name,notes,recipe_url,suggested_by) VALUES (?,?,?,?)").bind(name,String(b.notes||"").trim(),String(b.recipe_url||"").trim(),String(b.suggested_by||"").trim()).run();return json({ok:true,id:x.meta.last_row_id},201)}
if(url.pathname==="/api/rate"&&method==="POST"){const b=await body(request),mealId=Number(b.meal_id),rating=Number(b.rating),member=String(b.member||"").trim();if(!mealId||!member||rating<1||rating>5)return json({error:"Meal, family member and 1–5 rating are required."},400);await env.DB.prepare("INSERT INTO ratings (meal_id,member,rating,comment) VALUES (?,?,?,?) ON CONFLICT(meal_id,member) DO UPDATE SET rating=excluded.rating,comment=excluded.comment,created_at=CURRENT_TIMESTAMP").bind(mealId,member,rating,String(b.comment||"").trim()).run();return json({ok:true})}
if(url.pathname==="/api/vote"&&method==="POST"){const b=await body(request),mealId=Number(b.meal_id),member=String(b.member||"").trim();if(!mealId||!member)return json({error:"Meal and family member are required."},400);const x=await env.DB.prepare("SELECT id FROM meal_votes WHERE meal_id=? AND member=?").bind(mealId,member).first();if(x)await env.DB.prepare("DELETE FROM meal_votes WHERE id=?").bind(x.id).run();else await env.DB.prepare("INSERT INTO meal_votes (meal_id,member) VALUES (?,?)").bind(mealId,member).run();return json({ok:true,voted:!x})}
if(url.pathname==="/api/plan"&&method==="POST"){const b=await body(request),date=String(b.plan_date||"").trim();if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return json({error:"Valid plan date required."},400);await env.DB.prepare("INSERT INTO weekly_plan (plan_date,meal_id,note) VALUES (?,?,?) ON CONFLICT(plan_date) DO UPDATE SET meal_id=excluded.meal_id,note=excluded.note,updated_at=CURRENT_TIMESTAMP").bind(date,b.meal_id?Number(b.meal_id):null,String(b.note||"").trim()).run();return json({ok:true})}
return json({error:"Not found."},404)}};