# Prompt-transform eval — 2026-06-24 23:55

| id | provider | faith | flux | fluency | missing | issues |
|----|----------|:----:|:----:|:------:|---------|--------|
| animal_scene | gemini | 5 | 5 | 5 | — |  |
| person_action | gemini | 4 | 5 | 5 | sunset | It adds extra specifics like anime style, sitting, and acoustic guitar, but preserves the core scene correctly. |
| product | gemini | 5 | 5 | 5 | — |  |
| colors_count | gemini | 5 | 5 | 5 | white plate |  |
| cityscape | gemini | 5 | 5 | 5 | night |  |
| negation | gemini | 5 | 5 | 5 | no people |  |
| text_in_image | gemini | 5 | 4 | 5 | open | It adds extra scene details like the rainy city street, but the core requested sign text is preserved. |
| anime | gemini | 4 | 5 | 4 | sailor uniform, wind | It adds a school rooftop and a few extra mood details not stated in the original, and there is a small typo in “theskirt”. |
| abstract_mood | gemini | 4 | 5 | 5 | lonely | It invents a very specific pier-and-ocean scene rather than expressing loneliness more abstractly. |
| food_closeup | gemini | 5 | 5 | 5 | — |  |
| fantasy | gemini | 5 | 5 | 5 | volcano |  |
| cute_cat | gemini | 5 | 5 | 5 | orange cat, chubby |  |
| nature | gemini | 5 | 5 | 5 | — |  |
| two_subjects | gemini | 5 | 5 | 5 | old man |  |
| style_in_text | gemini | 5 | 5 | 5 | — |  |
| short | gemini | 4 | 5 | 5 | — | It adds many specific scene details not present in the original, though none directly conflict. |

## Generated prompts

- **animal_scene** (cute) — `一隻可愛柴犬在月球上吃拉麵`
  - An adorable 3D render of a cute Shiba Inu dog sitting on the dusty, cratered surface of the moon, happily eating a steaming bowl of ramen with noodles lifting into the air. The scene is characterized by soft rounded shapes and a warm pastel color palette, creating a gentle and cozy atmosphere against the backdrop of a starry cosmic sky. The lighting is soft and diffused, emphasizing the fluffy texture of the dog's fur and the comforting warmth of the meal.
- **person_action** (auto) — `一個女孩在櫻花樹下彈吉他，夕陽`
  - A serene anime-style illustration of a young girl sitting peacefully under a blooming cherry blossom tree, playing an acoustic guitar. Soft pink petals drift through the air around her, illuminated by the warm, golden glow of a setting sun. The color palette is filled with pastel pinks and deep oranges, creating a romantic and nostalgic mood, with a soft-focus background.
- **product** (product) — `一瓶玫瑰精油放在大理石桌上，柔和打光`
  - A professional studio product photograph of a bottle of rose essential oil resting on a polished white marble tabletop. The scene features a clean, seamless white background with crisp commercial lighting and soft, diffused shadows, creating a luxurious and minimalist mood. The color palette is dominated by clean whites and the delicate pink tones of the oil, captured with a macro lens for sharp detail and a shallow depth of field.
- **colors_count** (realistic) — `三顆紅蘋果和一顆青蘋果在白盤子上`
  - A photorealistic studio photograph of three vibrant red apples and one crisp green apple arranged neatly on a clean, minimalist white ceramic plate. The lighting is natural and soft, highlighting the true-to-life textures of the waxy skins and subtle water droplets on the surface. The composition is a clean top-down view with a bright, airy atmosphere and a neutral background, captured with a sharp macro lens for exquisite detail.
- **cityscape** (cinematic) — `台北101夜景，藍色時刻`
  - A cinematic film still of the Taipei 101 skyscraper towering over the city skyline during the blue hour, the building's lights shimmering against a deep indigo sky, with the city's glowing streetlights and traffic creating a bokeh effect in the foreground. The scene is captured with dramatic lighting and an atmospheric mood, utilizing a shallow depth of field to emphasize the tower's architectural grandeur, shot on 35mm film with rich, moody tones.
- **negation** (cinematic) — `空無一人的地鐵車廂，冷色調`
  - A cinematic film still of an empty subway car, drenched in a cold, sterile blue and grey color palette. Dramatic lighting casts long, sharp shadows across the rows of vacant seats and the reflective metallic floor, creating an atmospheric and lonely mood. Shot with a shallow depth of field, focusing on the empty space, captured on 35mm film with a high contrast and moody aesthetic.
- **text_in_image** (auto) — `霓虹招牌寫著「營業中」`
  - A cinematic photograph of a vibrant neon sign glowing in the dark, with the characters "營業中" written in a bright, electric blue and pink hue, casting a colorful reflection on a damp, rainy city street at night, atmospheric mood with a shallow depth of field, shot on a 35mm lens, high contrast and highly detailed.
- **anime** (anime) — `穿水手服的少女站在天台，風吹頭髮`
  - A vibrant anime illustration of a young girl wearing a classic sailor school uniform, standing on a school rooftop under a vast blue sky. Her hair and theskirt of her uniform are fluttering gracefully in a strong breeze, creating a dynamic sense of movement. The scene is filled with clean, bold colors and expressive character design, with bright daylight casting soft shadows, evoking a feeling of youth and nostalgia.
- **abstract_mood** (auto) — `孤獨的感覺`
  - A poignant, cinematic photograph of a single, solitary figure standing at the far end of a vast, empty concrete pier extending into a misty, slate-grey ocean under a heavy overcast sky. The lighting is diffused and cold, creating a mood of profound isolation and melancholy. The color palette is dominated by muted tones of charcoal, steel blue, and pale grey, shot with a wide-angle lens to emphasize the overwhelming scale of the emptiness surrounding the person.
- **food_closeup** (realistic) — `一碗熱騰騰的牛肉麵特寫，蒸氣`
  - A photorealistic close-up photograph of a steaming bowl of Taiwanese beef noodle soup, with rich brown broth, tender chunks of beef, and thick noodles, wisps of translucent steam rising gracefully from the surface, natural soft lighting highlighting the true-to-life textures of the green scallions and the glistening broth, shot with a macro lens for an appetizing and detailed culinary presentation.
- **fantasy** (cinematic) — `騎著龍的騎士飛越火山`
  - A cinematic film still of a brave knight in shimmering silver armor riding atop a massive, powerful dragon, soaring through a sky filled with ash and embers as they fly over a churning sea of molten lava in a volcanic crater. Dramatic, high-contrast lighting with a fiery orange glow illuminating the knight's armor and the dragon's scales. Atmospheric mood with thick smoke and heat haze, shot with a shallow depth of field to emphasize the epic scale, highly detailed.
- **cute_cat** (cute) — `一隻戴帽子的胖橘貓`
  - An adorable digital illustration of a plump orange tabby cat wearing a cozy, knitted hat. The cat is depicted with soft, rounded shapes and rendered in a warm pastel color palette, creating a gentle and cozy atmosphere. The art style is clean and whimsical, with soft lighting that enhances the fluffy texture of the fur and the fabric of the hat.
- **nature** (auto) — `清晨薄霧中的杉樹林，陽光穿透`
  - A serene photograph of a dense cedar forest shrouded in a soft, ethereal morning mist, with brilliant shafts of golden sunlight piercing through the tall canopy in a Tyndall effect. The color palette is dominated by deep forest greens and cool atmospheric greys, creating a tranquil and mysterious mood. Shot with a wide-angle lens to capture the towering height of the trees, with a crisp focus and a high dynamic range.
- **two_subjects** (realistic) — `老人和小孩在公園長椅上下棋`
  - A photorealistic image of an elderly man and a young child sitting side-by-side on a weathered wooden park bench, deeply focused on a game of chess between them. The scene is set in a lush green park during a sunny afternoon, with dappled sunlight filtering through the overhead canopy of ancient oak trees. The color palette is natural and warm, evoking a sense of generational connection and quiet wisdom. Every detail is captured with true-to-life textures, from the wrinkles on the man's weathered hands to the soft fabric of the child's clothing, shot with a 85mm lens for a soft, natural background blur.
- **style_in_text** (auto) — `梵谷風格的星空下的小鎮`
  - An expressive oil painting in the style of Vincent van Gogh, depicting a quiet small town nestled under a swirling, luminous starry night sky. The scene is filled with thick, impasto brushstrokes and rhythmic spirals of deep blue and golden yellow, creating a vibrant and emotional atmosphere. The town's quaint houses and a tall cypress tree are rendered in bold, contrasting colors, evoking a sense of dreamlike movement and cosmic energy.
- **short** (auto) — `貓`
  - A high-resolution photograph of a fluffy, majestic cat with expressive eyes, sitting elegantly on a soft, neutral-toned rug in a sun-drenched living room. Warm, natural light streams through a nearby window, creating a soft glow and highlighting the detailed texture of its fur. The mood is peaceful and serene, captured with a 85mm lens for a shallow depth of field and a creamy bokeh background.