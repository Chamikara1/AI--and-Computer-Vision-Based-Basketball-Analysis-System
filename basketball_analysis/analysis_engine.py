"""
Analysis Engine — Refactored pipeline with progress callbacks and JSON export.

This module wraps the existing basketball analysis pipeline and adds:
1. A progress callback system so the UI can show real-time progress
2. Per-frame JSON data export for the dashboard to consume
"""

import os
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["OBJC_DISABLE_INITIALIZE_FORK_SAFETY"] = "YES"

import json
import time
import subprocess
from utils import read_video, save_video, get_video_fps
from trackers import PlayerTracker, BallTracker
from team_assigner import TeamAssigner
from court_keypoint_detector import CourtKeypointDetector
from ball_aquisition import BallAquisitionDetector
from pass_and_interception_detector import PassAndInterceptionDetector
from tactical_view_converter import TacticalViewConverter
from speed_and_distance_calculator import SpeedAndDistanceCalculator
from drawers import (
    PlayerTracksDrawer, 
    BallTracksDrawer,
    CourtKeypointDrawer,
    TeamBallControlDrawer,
    FrameNumberDrawer,
    PassInterceptionDrawer,
    TacticalViewDrawer,
    SpeedAndDistanceDrawer
)
from configs import (
    STUBS_DEFAULT_PATH,
    PLAYER_DETECTOR_PATH,
    BALL_DETECTOR_PATH,
    COURT_KEYPOINT_DETECTOR_PATH,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def convert_avi_to_mp4(avi_path, mp4_path):
    """Convert AVI to MP4 using ffmpeg for browser playback."""
    try:
        subprocess.run([
            'ffmpeg', '-y', '-i', avi_path,
            '-c:v', 'libx264', '-preset', 'fast',
            '-crf', '23', '-pix_fmt', 'yuv420p',
            mp4_path
        ], check=True, capture_output=True)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        # If ffmpeg not available, try with opencv
        return False


def run_analysis(input_video_path, output_video_path, stub_path=STUBS_DEFAULT_PATH, progress_callback=None):
    """
    Run the full basketball analysis pipeline.

    Args:
        input_video_path: Path to input video file
        output_video_path: Path for output annotated video
        stub_path: Path to stub/cache directory
        progress_callback: Function(stage, progress_pct, message) called with updates

    Returns:
        dict with keys:
            'output_video': path to output video (.mp4)
            'frame_data': list of per-frame data dicts
            'summary': overall summary stats
    """
    def report(stage, pct, msg):
        if progress_callback:
            progress_callback(stage, pct, msg)

    start_time = time.time()

    # ── Stage 1: Read Video ──────────────────────────────────────────
    report("reading_video", 0, "Reading input video...")
    video_frames = read_video(input_video_path)
    video_fps = get_video_fps(input_video_path)
    total_frames = len(video_frames)
    report("reading_video", 100, f"Read {total_frames} frames")

    # ── Stage 2: Player Detection ────────────────────────────────────
    report("player_detection", 0, "Detecting players (YOLOv11)...")
    player_tracker = PlayerTracker(PLAYER_DETECTOR_PATH)
    player_tracks = player_tracker.get_object_tracks(
        video_frames,
        read_from_stub=True,
        stub_path=os.path.join(stub_path, 'player_track_stubs.pkl')
    )
    report("player_detection", 100, f"Player detection complete — {total_frames} frames")

    # ── Stage 3: Ball Detection ──────────────────────────────────────
    report("ball_detection", 0, "Detecting ball (YOLOv5)...")
    ball_tracker = BallTracker(BALL_DETECTOR_PATH)
    ball_tracks = ball_tracker.get_object_tracks(
        video_frames,
        read_from_stub=True,
        stub_path=os.path.join(stub_path, 'ball_track_stubs.pkl')
    )
    report("ball_detection", 100, "Ball detection complete")

    # ── Stage 4: Court Keypoint Detection ────────────────────────────
    report("court_detection", 0, "Detecting court keypoints (YOLOv8)...")
    court_keypoint_detector = CourtKeypointDetector(COURT_KEYPOINT_DETECTOR_PATH)
    court_keypoints_per_frame = court_keypoint_detector.get_court_keypoints(
        video_frames,
        read_from_stub=True,
        stub_path=os.path.join(stub_path, 'court_key_points_stub.pkl')
    )
    report("court_detection", 100, "Court keypoint detection complete")

    # ── Stage 5: Post-processing ─────────────────────────────────────
    report("post_processing", 0, "Cleaning ball tracks...")
    ball_tracks = ball_tracker.remove_wrong_detections(ball_tracks)
    ball_tracks = ball_tracker.interpolate_ball_positions(ball_tracks)
    report("post_processing", 30, "Ball tracks cleaned")

    # Team Assignment
    report("post_processing", 30, "Assigning teams (FashionCLIP)...")
    team_assigner = TeamAssigner()
    player_assignment = team_assigner.get_player_teams_across_frames(
        video_frames, player_tracks,
        read_from_stub=True,
        stub_path=os.path.join(stub_path, 'player_assignment_stub.pkl')
    )
    report("post_processing", 60, "Team assignment complete")

    # Ball Acquisition
    report("post_processing", 60, "Detecting ball possession...")
    ball_aquisition_detector = BallAquisitionDetector()
    ball_aquisition = ball_aquisition_detector.detect_ball_possession(player_tracks, ball_tracks)
    report("post_processing", 70, "Ball possession detected")

    # Passes & Interceptions
    report("post_processing", 70, "Detecting passes and interceptions...")
    pass_detector = PassAndInterceptionDetector()
    passes = pass_detector.detect_passes(ball_aquisition, player_assignment)
    interceptions = pass_detector.detect_interceptions(ball_aquisition, player_assignment)
    report("post_processing", 80, "Pass/interception detection complete")

    # Tactical View
    report("post_processing", 80, "Computing tactical view (homography)...")
    tactical_view_converter = TacticalViewConverter(court_image_path=os.path.join(BASE_DIR, "images", "basketball_court.png"))
    court_keypoints_per_frame = tactical_view_converter.validate_keypoints(court_keypoints_per_frame)
    tactical_player_positions = tactical_view_converter.transform_players_to_tactical_view(
        court_keypoints_per_frame, player_tracks
    )
    report("post_processing", 90, "Tactical view computed")

    # Speed & Distance
    report("post_processing", 90, "Calculating speed and distance...")
    speed_calc = SpeedAndDistanceCalculator(
        tactical_view_converter.width,
        tactical_view_converter.height,
        tactical_view_converter.actual_width_in_meters,
        tactical_view_converter.actual_height_in_meters
    )
    player_distances_per_frame = speed_calc.calculate_distance(tactical_player_positions)
    player_speed_per_frame = speed_calc.calculate_speed(player_distances_per_frame)
    report("post_processing", 100, "All analysis complete")

    # ── Stage 6: Build per-frame JSON data ───────────────────────────
    report("exporting_data", 0, "Building frame data...")

    import numpy as np
    # Pre-compute team ball control
    team_ball_control = []
    for pa_frame, ba_frame in zip(player_assignment, ball_aquisition):
        if ba_frame == -1 or ba_frame not in pa_frame:
            team_ball_control.append(-1)
        elif pa_frame[ba_frame] == 1:
            team_ball_control.append(1)
        else:
            team_ball_control.append(2)
    team_ball_control_np = np.array(team_ball_control)

    # Cumulative total distances
    total_distances = {}

    frame_data_list = []
    for f in range(total_frames):
        # Players
        players_data = {}
        for pid, pinfo in player_tracks[f].items():
            bbox = pinfo.get('bbox', [])
            team_id = int(player_assignment[f].get(pid, 1))
            has_ball = bool(ball_aquisition[f] == pid)

            speed = player_speed_per_frame[f].get(pid, 0) if f < len(player_speed_per_frame) else 0
            dist = player_distances_per_frame[f].get(pid, 0) if f < len(player_distances_per_frame) else 0

            if pid not in total_distances:
                total_distances[pid] = 0
            total_distances[pid] += dist

            tac_pos = None
            if f < len(tactical_player_positions) and pid in tactical_player_positions[f]:
                tac_pos = tactical_player_positions[f][pid]

            players_data[str(pid)] = {
                "bbox": [round(float(x), 1) for x in bbox],
                "team": int(team_id),
                "has_ball": bool(has_ball),
                "speed_kmh": round(speed, 2),
                "total_distance_m": round(total_distances[pid], 2),
                "frame_distance_m": round(dist, 2),
                "tactical_position": [round(float(x), 1) for x in tac_pos] if tac_pos else None
            }

        # Ball
        ball_info = ball_tracks[f].get(1, {})
        ball_bbox = ball_info.get('bbox', None)
        ball_detected = bool(ball_bbox is not None and len(ball_bbox) > 0) if isinstance(ball_bbox, (list, tuple)) else bool(ball_bbox is not None)

        # Stats
        tbc_till = team_ball_control_np[:f + 1]
        t1_ctrl = int(np.sum(tbc_till == 1))
        t2_ctrl = int(np.sum(tbc_till == 2))
        total_ctrl = max(t1_ctrl + t2_ctrl, 1)

        passes_till = passes[:f + 1]
        interceptions_till = interceptions[:f + 1]
        t1_passes = sum(1 for p in passes_till if p == 1)
        t2_passes = sum(1 for p in passes_till if p == 2)
        t1_interceptions = sum(1 for i in interceptions_till if i == 1)
        t2_interceptions = sum(1 for i in interceptions_till if i == 2)

        # Events at this frame
        events = []
        if f < len(passes) and passes[f] == 1:
            events.append("PASS_TEAM1")
        elif f < len(passes) and passes[f] == 2:
            events.append("PASS_TEAM2")
        if f < len(interceptions) and interceptions[f] == 1:
            events.append("INTERCEPTION_TEAM1")
        elif f < len(interceptions) and interceptions[f] == 2:
            events.append("INTERCEPTION_TEAM2")

        frame_data_list.append({
            "frame_number": f,
            "players": players_data,
            "ball": {
                "bbox": [round(float(x), 1) for x in ball_bbox] if ball_bbox and ball_detected else None,
                "detected": bool(ball_detected)
            },
            "ball_holder": int(ball_aquisition[f]) if ball_aquisition[f] != -1 else None,
            "stats": {
                "team1_ball_control_pct": round((t1_ctrl / total_ctrl) * 100, 2),
                "team2_ball_control_pct": round((t2_ctrl / total_ctrl) * 100, 2),
                "team1_passes": t1_passes,
                "team2_passes": t2_passes,
                "team1_interceptions": t1_interceptions,
                "team2_interceptions": t2_interceptions
            },
            "events": events
        })

        if f % 10 == 0:
            report("exporting_data", int((f / total_frames) * 100), f"Frame {f}/{total_frames}")

    report("exporting_data", 100, "Frame data exported")

    # ── Stage 7: Render annotated video ──────────────────────────────
    report("rendering_video", 0, "Rendering annotated output video...")

    player_tracks_drawer = PlayerTracksDrawer()
    ball_tracks_drawer = BallTracksDrawer()
    court_keypoint_drawer = CourtKeypointDrawer()
    frame_number_drawer = FrameNumberDrawer()
    tactical_view_drawer = TacticalViewDrawer()
    speed_distance_drawer = SpeedAndDistanceDrawer()

    output_video_frames = player_tracks_drawer.draw(video_frames, player_tracks, player_assignment, ball_aquisition)
    report("rendering_video", 15, "Player tracks drawn")

    output_video_frames = ball_tracks_drawer.draw(output_video_frames, ball_tracks)
    report("rendering_video", 25, "Ball tracks drawn")

    output_video_frames = court_keypoint_drawer.draw(output_video_frames, court_keypoints_per_frame)
    report("rendering_video", 35, "Court keypoints drawn")

    output_video_frames = frame_number_drawer.draw(output_video_frames)
    report("rendering_video", 40, "Frame numbers drawn")

    output_video_frames = speed_distance_drawer.draw(output_video_frames, player_tracks, player_distances_per_frame, player_speed_per_frame)
    report("rendering_video", 80, "Speed and distance labels drawn")

    output_video_frames = tactical_view_drawer.draw(
        output_video_frames,
        tactical_view_converter.court_image_path,
        tactical_view_converter.width,
        tactical_view_converter.height,
        tactical_view_converter.key_points,
        tactical_player_positions,
        player_assignment,
        ball_aquisition
    )
    report("rendering_video", 90, "Tactical view drawn")

    # Save MP4 natively
    mp4_path = output_video_path
    if not mp4_path.endswith('.mp4'):
        mp4_path = output_video_path.rsplit('.', 1)[0] + '.mp4'
    save_video(output_video_frames, mp4_path, fps=video_fps)

    report("rendering_video", 100, "Video rendering complete")

    elapsed = time.time() - start_time

    # Build summary
    summary = {
        "total_frames": total_frames,
        "processing_time_seconds": round(elapsed, 2),
        "total_players_tracked": len(set(
            pid for f in player_tracks for pid in f.keys()
        )),
        "final_stats": frame_data_list[-1]["stats"] if frame_data_list else {},
        "total_events": {
            "passes_team1": sum(1 for p in passes if p == 1),
            "passes_team2": sum(1 for p in passes if p == 2),
            "interceptions_team1": sum(1 for i in interceptions if i == 1),
            "interceptions_team2": sum(1 for i in interceptions if i == 2),
        }
    }

    # Save JSON data
    json_path = mp4_path.rsplit('.', 1)[0] + '_data.json'
    with open(json_path, 'w') as jf:
        json.dump({
            "summary": summary,
            "frames": frame_data_list
        }, jf)

    report("complete", 100, f"Analysis complete in {elapsed:.1f}s")

    return {
        "output_video": mp4_path,
        "output_video_avi": mp4_path,
        "json_data_path": json_path,
        "frame_data": frame_data_list,
        "summary": summary
    }
