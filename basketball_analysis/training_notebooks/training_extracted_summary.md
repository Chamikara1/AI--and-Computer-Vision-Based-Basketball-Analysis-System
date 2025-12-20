# Training Notebooks Extracted Summary

## 1. Ball / Basketball Object Detection Training

- Notebook: `basketball_ball_training.ipynb`
- Libraries installed: `ultralytics`, `roboflow`
- Main imports: `shutil`, `Roboflow`
- Dataset source: Roboflow
- Workspace: `workspace-5ujvu`
- Project: `basketball-players-fy4c2-vfsuv`
- Dataset version: `17`
- Dataset format: `yolov5`
- Task: object detection
- Mode: training
- Model: `yolov5l6u.p` in notebook command, but saved output shows training used `best.pt`
- Epochs in notebook command: `250`
- Epochs shown in saved output: `100`
- Image size: `640`
- Batch size shown in saved output: `16`
- Optimizer: `AdamW`
- Learning rate: `0.000909`
- Momentum: `0.9`
- Device/runtime shown in output: Python 3.11.11, Torch 2.5.1+cu121, CUDA Tesla T4
- Model size shown in output: YOLOv5l6u, 86,024,876 parameters, 137.7 GFLOPs
- Training duration shown in output: 100 epochs completed in 0.965 hours
- Saved results path: `runs/detect/train`
- Best weights path: `runs/detect/train/weights/best.pt`
- Last weights path: `runs/detect/train/weights/last.pt`
- Validation set: 32 images, 483 instances

Final visible evaluation row:

| Class | Images | Instances | Precision | Recall | mAP50 | mAP50-95 |
|---|---:|---:|---:|---:|---:|---:|
| all | 32 | 483 | 0.919 | 0.845 | 0.909 | 0.699 |

## 2. Player Detection Training

- Notebook: `basketball_player_detection_training.ipynb`
- Libraries installed: `ultralytics`, `roboflow`
- Main imports: `Roboflow`, `shutil`
- Dataset source: Roboflow
- Workspace: `workspace-5ujvu`
- Project: `basketball-players-fy4c2-vfsuv`
- Dataset version: `17`
- Dataset format: `yolov5`
- Task: object detection
- Mode: training
- Model: `yolov5l6u.pt`
- Epochs: `100`
- Image size: `640`
- Batch size: `8`
- Plots enabled: `True`
- Optimizer: `AdamW`
- Learning rate: `0.000909`
- Momentum: `0.9`
- Device/runtime shown in output: Python 3.11.11, Torch 2.6.0+cu124, CUDA Tesla T4
- Model size shown in output: YOLOv5l6u, 86,024,876 parameters, 137.7 GFLOPs
- Training duration shown in output: 100 epochs completed in 0.694 hours
- Saved results path: `runs/detect/train2`
- Best weights path: `runs/detect/train2/weights/best.pt`
- Last weights path: `runs/detect/train2/weights/last.pt`
- Validation set: 32 images, 483 instances

Final visible evaluation row:

| Class | Images | Instances | Precision | Recall | mAP50 | mAP50-95 |
|---|---:|---:|---:|---:|---:|---:|
| all | 32 | 483 | 0.946 | 0.908 | 0.950 | 0.755 |

## 3. Court Keypoint / Pose Training

- Notebook: `basketball_court_keypoint_training.ipynb`
- Libraries installed: `ultralytics`, `roboflow`
- Main imports: `cv2`, `numpy`, `os`, `random`, `shutil`, `matplotlib.pyplot`, `Roboflow`
- Dataset source: Roboflow
- Workspace: `fyp-3bwmg`
- Project: `reloc2-den7l`
- Dataset version: `1`
- Dataset format: `yolov8`
- Task: pose/keypoint detection
- Mode: training
- Model: `yolov8x-pose.pt`
- Epochs: `500`
- Image size: `640`
- Batch size: `16`
- Saved evaluation output: not available in the notebook

## Notes

- The player detection notebook contains a visible Roboflow API key. It should be removed or regenerated before submission or sharing.
- The ball/object notebook has a mismatch between the command cell and saved training output: the command says `epochs=250`, but the saved output shows a completed 100-epoch run.
- No local `results.csv`, confusion matrix image, PR curve, or exported training plot files were found in the project tree.
