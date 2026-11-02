extends Node2D

var player_position = Vector2(100, 100)

func _process(delta):
	player_position.x += (int(Input.is_action_pressed("ui_right")) - int(Input.is_action_pressed("ui_left"))) * 120 * delta
	player_position.y += (int(Input.is_action_pressed("ui_down")) - int(Input.is_action_pressed("ui_up"))) * 120 * delta
	update()

func _draw():
	draw_circle(player_position, 16, Color(0.2, 0.7, 1))
