"""Hub for tall screens: the same dark, flooded gallery, hung in two rows.

A phone held upright sees two walls of hub.py, with nothing but ceiling over
them. Here the room is higher and those two walls carry all four paintings,
the prints over the oils, as pictures were once hung in salons; what was
lettered on the walls at the sides comes round to the next ones. Everything
else (light, water, dais, door, the eye) is the same, so that the viewer can
change one room for the other when the screen is turned.
"""

import hub

BELOW, ABOVE = 1.72, 4.76  # height of the centres of each row (m)

hub.GEOMETRY = "hub-tall-geometry.json"
hub.CEILING = 6.9
hub.PAINTINGS = [
    ("wave", "wave.jpg", -17, 1.6, "print", ABOVE, 3.56),
    ("rain", "rain.jpg", 17, 1.75, "print", ABOVE, 3.56),
    ("stillness", "stillness.jpg", -17, 2.0, "oil", BELOW, 0.54),
    ("moonlight", "moonlight.jpg", 17, 1.85, "oil", BELOW, 0.54),
]
hub.WALLS = [-58, -17, 17, 58, 100, 140, 180, 220, 260]
hub.LETTERING = [(302, hub.LETTERING[0][1]), (58, hub.LETTERING[1][1])]
hub.LETTERING_AT = 2.4
hub.SPOT_ASIDE = 0.3
hub.SPOT_REACH = 1.2
hub.SPOT_POWER = 470
hub.SPOT_BLEND = 0.8
hub.WASHER_POWER = 3.4

build = hub.build
