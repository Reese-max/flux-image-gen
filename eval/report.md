# Prompt-transform eval — 2026-06-24 23:06

| id | provider | faith | flux | fluency | missing | issues |
|----|----------|:----:|:----:|:------:|---------|--------|
| animal_scene | gemini | 5 | 5 | 5 | — | Adds extra scene details like a starry void and glowing Earth that were not in the original description. |
| person_action | gemini | 5 | 5 | 5 | — |  |
| product | gemini | 5 | 5 | 5 | — |  |
| colors_count | gemini | 5 | 5 | 5 | white plate |  |
| cityscape | gemini | 5 | 4 | 3 | night | Minor grammar errors such as "a atmospheric" make the English less fluent. |
| negation | gemini | 5 | 5 | 5 | no people |  |
| text_in_image | gemini | 1 | 5 | 5 | — | It changes the sign text into Japanese characters instead of the Chinese phrase「營業中」. |
| anime | rule_based | 1 | 1 | 3 | sailor uniform, rooftop, wind, hair | It omits all key scene details like the sailor uniform, rooftop setting, and wind-blown hair, and reads more like tags than a full prompt. |
| abstract_mood | gemini | 3 | 5 | 5 | lonely | It invents a very specific landscape scene that the original did not specify, though it preserves the lonely mood. |
| food_closeup | gemini | 4 | 5 | 5 | — | It adds extra specifics like Taiwanese, the table, and lighting that were not in the original, though they do not conflict. |
| fantasy | gemini | 5 | 5 | 5 | — |  |
| cute_cat | gemini | 5 | 5 | 5 | orange cat |  |
| nature | gemini | 5 | 5 | 5 | — |  |
| two_subjects | gemini | 5 | 5 | 5 | old man |  |
| style_in_text | gemini | 5 | 5 | 4 | starry | There is a small typo (“a a”) that hurts polish, but the prompt is otherwise fluent and faithful. |
| short | gemini | 4 | 5 | 5 | — | Adds many specific details not present in the original, but it still preserves the core subject. |

## Generated prompts

- **animal_scene** (cute) — `一隻可愛柴犬在月球上吃拉麵`
  - An adorable digital illustration of a cute Shiba Inu dog sitting on the dusty, cratered surface of the moon, happily eating a steaming bowl of ramen. The scene is rendered with soft rounded shapes and a warm pastel color palette, creating a gentle and cozy mood. The background features a vast, starry cosmic void with a distant, glowing earth, all in a whimsical and dreamy art style.
- **person_action** (auto) — `一個女孩在櫻花樹下彈吉他，夕陽`
  - A serene anime-style illustration of a young girl sitting beneath a blooming cherry blossom tree, gently playing an acoustic guitar. The scene is bathed in the warm, golden light of a late afternoon sunset, with delicate pink petals drifting through the air. The color palette is soft and romantic, featuring pastel pinks and deep oranges, creating a peaceful and nostalgic mood, rendered with clean lines and luminous lighting.
- **product** (product) — `一瓶玫瑰精油放在大理石桌上，柔和打光`
  - A high-end studio product photograph of a luxurious bottle of rose essential oil resting on a polished white marble tabletop. The scene features a clean, seamless background with crisp commercial lighting and soft, diffused highlights that accentuate the glass bottle's contours. The color palette is dominated by elegant whites and soft pinks, creating a sophisticated and serene mood, captured with a macro lens for extreme clarity and a sharp focus.
- **colors_count** (realistic) — `三顆紅蘋果和一顆青蘋果在白盤子上`
  - A photorealistic studio photograph of three vibrant red apples and one crisp green apple arranged on a minimalist white ceramic plate. The scene is illuminated by soft, natural daylight streaming from a side window, highlighting the waxy textures of the skins and tiny water droplets on the surface. The color palette is clean and bright, creating a fresh and organic mood, shot with a macro lens to capture every fine detail with a sharp focus and a soft, blurred background.
- **cityscape** (cinematic) — `台北101夜景，藍色時刻`
  - A cinematic film still of the Taipei 101 skyscraper towering over the city skyline during the blue hour, the building's architectural lights glowing against a deep indigo sky, the city below a sea of twinkling amber lights and soft bokeh, dramatic lighting with a atmospheric mood, shot on a 35mm anamorphic lens with a shallow depth of field to create a professional movie look.
- **negation** (cinematic) — `空無一人的地鐵車廂，冷色調`
  - A cinematic film still of an empty subway carriage, bathed in cold, sterile blue and grey tones, with dramatic lighting creating deep shadows and a lonely, atmospheric mood. The scene is captured with a shallow depth of field, focusing on the rows of empty seats and the polished metallic surfaces, evoking a sense of urban isolation and silence.
- **text_in_image** (auto) — `霓虹招牌寫著「營業中」`
  - A cinematic photograph of a vibrant neon sign glowing in a dark, rainy city alleyway, the sign displaying the Japanese characters for 'Open' in a brilliant electric blue and hot pink hue, reflecting off the wet asphalt ground. The scene is captured at night with a high contrast, moody atmosphere, shot on a 35mm lens to capture the gritty urban environment with a sharp focus on the glowing tubes of the neon light.
- **anime** (anime) — `穿水手服的少女站在天台，風吹頭髮`
  - imaginative visual scene, anime style, expressive character design, vibrant colors, highly detailed
- **abstract_mood** (auto) — `孤獨的感覺`
  - A poignant cinematic photograph of a single, small figure standing alone on a vast, mist-covered salt flat under a heavy, overcast grey sky. The composition is a wide shot, emphasizing the immense scale of the emptiness around the person, creating a profound sense of solitude and melancholy. The color palette is muted with cold blue and charcoal tones, captured with a wide-angle lens to enhance the feeling of isolation, high contrast and sharp detail.
- **food_closeup** (realistic) — `一碗熱騰騰的牛肉麵特寫，蒸氣`
  - A hyper-realistic close-up photograph of a steaming bowl of Taiwanese beef noodle soup, with rich brown broth, tender chunks of beef, and thick noodles, delicate wisps of steam rising from the surface. The scene is set on a rustic wooden table under natural, soft daylight, highlighting the glistening textures of the meat and the freshness of green scallions. Captured with a macro lens to emphasize the detailed textures and a shallow depth of field for a soft, appetizing background.
- **fantasy** (cinematic) — `騎著龍的騎士飛越火山`
  - A cinematic film still of a heroic knight in ornate armor riding a massive, scaled dragon as they soar through a sky filled with ash and embers, flying directly over a churning caldera of a glowing volcano. Dramatic lighting with intense orange glows from the molten lava below casting deep shadows, creating an atmospheric and tense mood. The shot is captured with a shallow depth of field, focusing on the knight's determined expression, rendered in a high-contrast, epic cinematic style.
- **cute_cat** (cute) — `一隻戴帽子的胖橘貓`
  - A charming, high-quality 3D render of a chubby orange tabby cat wearing a tiny, cozy knitted hat. The cat is depicted with soft, rounded shapes and a gentle expression, set against a warm, pastel-colored background that enhances the cozy and inviting mood. The lighting is soft and diffused, creating a sweet and heartwarming atmosphere with a smooth, matte finish.
- **nature** (auto) — `清晨薄霧中的杉樹林，陽光穿透`
  - A breathtaking landscape photograph of a dense cedar forest shrouded in soft morning mist, with brilliant beams of sunlight piercing through the towering canopy in dramatic god rays. The scene is bathed in a cool, ethereal atmosphere with a palette of deep forest greens and silvery greys, captured with a wide-angle lens to emphasize the scale of the trees and a deep depth of field for crisp, atmospheric detail.
- **two_subjects** (realistic) — `老人和小孩在公園長椅上下棋`
  - A photorealistic image of an elderly man and a young child sitting side-by-side on a weathered wooden park bench, deeply focused on a game of chess between them. The scene is set in a lush green public park during a mid-afternoon, with dappled sunlight filtering through the canopy of large leafy trees. The color palette is natural and earthy, evoking a feeling of generational connection and quiet wisdom. The shot is captured with a high-resolution camera, featuring true-to-life skin textures, detailed fabric on their clothing, and a soft bokeh background.
- **style_in_text** (auto) — `梵谷風格的星空下的小鎮`
  - A breathtaking oil painting in the swirling, expressive style of Vincent van Gogh, depicting a quiet small town nestled under a vast, turbulent night sky filled with glowing yellow stars and a crescent moon. The landscape is defined by bold, thick impasto brushstrokes and rhythmic spirals of deep cobalt blue and gold, creating a a dreamy, emotive atmosphere of cosmic energy and nocturnal peace.
- **short** (auto) — `貓`
  - A professional studio photograph of a majestic long-haired cat with striking green eyes, sitting elegantly on a plush velvet cushion, soft high-key lighting that accentuates the texture of its fluffy fur, a clean minimalist background, shot with a 85mm lens for a crisp portrait with a soft bokeh effect.