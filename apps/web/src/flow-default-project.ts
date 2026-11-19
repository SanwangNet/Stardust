// 基于用户提供的 Stardust 设计工程 (1).json 重建的默认设计。
export const defaultProjectData: unknown = {
  "schemaVersion": 1,
  "projectId": "db13a1cb-8d62-4429-9214-0a2802a2ac8a",
  "projectName": "Stardust 设计工程",
  "rootBoardId": "d68014d6-12dd-4304-92e6-e3e4bc5ad4d4",
  "boards": [
    {
      "id": "d68014d6-12dd-4304-92e6-e3e4bc5ad4d4",
      "name": "主流程",
      "nodes": [
        {
          "id": "b44c8df7-ddcb-4d94-9555-31946ee3ed89",
          "title": "QQ 消息",
          "subtitle": "QQ 入站 · 当前消息",
          "position": {
            "x": 0,
            "y": 0
          },
          "visualStyle": "input",
          "inputPorts": [
            {
              "id": "9f57f002-bf2d-46e0-a6e8-805a75f6cc24",
              "name": "输入"
            }
          ],
          "outputPorts": [
            {
              "id": "a2142584-5536-4800-817b-6bee9968d7f8",
              "name": "输出",
              "side": "right"
            }
          ],
          "childBoardId": "92a093d6-a325-4d0f-a263-8809bf26b370"
        },
        {
          "id": "fe3e3f19-b477-4e28-8508-0e505234abd3",
          "title": "Web 对话",
          "subtitle": "Web 会话入口",
          "position": {
            "x": 0,
            "y": 240
          },
          "visualStyle": "input",
          "inputPorts": [
            {
              "id": "23727d3f-5b36-45bf-b7db-9b3dfc4477b0",
              "name": "输入"
            }
          ],
          "outputPorts": [
            {
              "id": "647495e8-6826-48b5-9292-5504d71a5efe",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "0c39c13d-96b2-4f1d-8f78-20d25fb2eb3b",
          "title": "QQ 输入适配",
          "subtitle": "私聊 / 群聊 @ 过滤",
          "position": {
            "x": 300,
            "y": 0
          },
          "visualStyle": "input",
          "inputPorts": [
            {
              "id": "75c5d245-f8be-4a66-a046-d13dcdc9055c",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "e201db4d-4193-4cc1-b4ac-321e4f46b499",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "56b01adb-4fe9-484b-b9cc-3736ed459cb5",
          "title": "Web 输入适配",
          "subtitle": "会话与请求校验",
          "position": {
            "x": 300,
            "y": 240
          },
          "visualStyle": "input",
          "inputPorts": [
            {
              "id": "6eaf0ad8-0365-40be-a3e6-cd586c402511",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "809d97ed-22f7-4e23-afb3-d6a8a0479cdd",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "57babe78-9d81-4fca-aee4-721f872cca8a",
          "title": "上下文准备",
          "subtitle": "Web 历史 / QQ 当前消息",
          "position": {
            "x": 600,
            "y": 120
          },
          "visualStyle": "context",
          "inputPorts": [
            {
              "id": "f9ef81c4-3d4c-49ef-a0a9-d975cf16ba11",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "797d2af2-ebd3-4830-9dbb-2dd0452c67ee",
              "name": "输出",
              "side": "right"
            }
          ],
          "childBoardId": "0ea36c05-8e6f-4782-8110-e90b4e8f1e82"
        },
        {
          "id": "4cebf490-3782-4380-91c7-8ee4689dcc71",
          "title": "主 Agent",
          "subtitle": "统一身份与渠道提示",
          "position": {
            "x": 900,
            "y": 120
          },
          "visualStyle": "model",
          "inputPorts": [
            {
              "id": "915b9840-3c75-4274-9f88-126c7d7e18c4",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "786326dc-ef4b-4cc8-beb0-870309593367",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "541e3489-0cf7-4e14-a0a0-819d7e101fe3",
          "title": "模型调用",
          "subtitle": "按请求生成响应",
          "position": {
            "x": 1200,
            "y": 120
          },
          "visualStyle": "model",
          "inputPorts": [
            {
              "id": "68e66a6a-5707-4af2-8f9c-2a758d7b9417",
              "name": "输入",
              "side": "left"
            },
            {
              "id": "09fddd07-f175-4b61-9813-6744c3a8da44",
              "name": "输入",
              "side": "top"
            },
            {
              "id": "d5ac0ab1-e981-4f5c-b6e3-42bbc988cd30",
              "name": "输入",
              "side": "right"
            }
          ],
          "outputPorts": [
            {
              "id": "f8858807-49ce-4758-9fd9-ce63cf585a50",
              "name": "输出",
              "side": "right"
            },
            {
              "id": "3efafe18-3695-48e2-9890-751c9bf4ea19",
              "name": "输出",
              "side": "bottom"
            }
          ]
        },
        {
          "id": "454e45b2-0c94-43b1-ab5d-d4c6eac90eb7",
          "title": "Skill 能力",
          "subtitle": "Web 选择与加载 · 开关控制",
          "position": {
            "x": 900,
            "y": -160
          },
          "visualStyle": "prompt",
          "inputPorts": [
            {
              "id": "26808b8f-4cfa-4515-a14e-b65b5dfcd3b0",
              "name": "输入"
            }
          ],
          "outputPorts": [
            {
              "id": "b70e028a-9f02-402d-94a9-33ef9ae16353",
              "name": "输出",
              "side": "bottom"
            }
          ],
          "childBoardId": "cbc34832-7368-445a-9743-9fdc94bcb14d"
        },
        {
          "id": "57643ae7-5ee6-403b-b184-d72636a42fe0",
          "title": "Tool 能力",
          "subtitle": "Web 按需调用 · Core 校验",
          "position": {
            "x": 1500,
            "y": -160
          },
          "visualStyle": "tool",
          "inputPorts": [
            {
              "id": "1a2f14d1-007e-4669-bf0d-62ae7226d8da",
              "name": "输入",
              "side": "top"
            },
            {
              "id": "36f37f5d-5f99-4c70-9291-a8754306fedf",
              "name": "输入",
              "side": "bottom"
            }
          ],
          "outputPorts": [
            {
              "id": "1a34d660-714d-4641-b76f-369ff35b9c77",
              "name": "输出",
              "side": "bottom"
            },
            {
              "id": "e5e0adc8-01bc-4d79-aa87-ddabb2329879",
              "name": "输出",
              "side": "left"
            }
          ],
          "childBoardId": "e8923e0d-e64f-4009-bac1-a0337714d606"
        },
        {
          "id": "027048c7-b2ad-4bf3-ae1f-941ebb4c4c13",
          "title": "沙盒能力",
          "subtitle": "规划中 · 按需使用",
          "position": {
            "x": 1200,
            "y": -360
          },
          "visualStyle": "tool",
          "inputPorts": [
            {
              "id": "db7cfb36-39ba-4ed7-a03e-1bf90d674ded",
              "name": "输入"
            }
          ],
          "outputPorts": [
            {
              "id": "69499ac7-11fe-47e5-932c-93850d1af45c",
              "name": "输出",
              "side": "right"
            }
          ],
          "childBoardId": "37da47c7-4f12-47c1-b2bc-f674cff425b3"
        },
        {
          "id": "31e0329e-81ca-45f5-b61d-9c272ce7f1f3",
          "title": "Tool Call",
          "subtitle": "模型选择调用",
          "position": {
            "x": 1500,
            "y": 120
          },
          "visualStyle": "tool",
          "inputPorts": [
            {
              "id": "a462b5ef-d014-4dc0-8ca2-6c982f8f0b0b",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "57bdb3a2-cc19-4591-9c11-210c546ce173",
              "name": "输出",
              "side": "top"
            }
          ]
        },
        {
          "id": "09f840cb-c3d1-4846-8fa1-d1efcaf1d935",
          "title": "输出路由",
          "subtitle": "按本轮来源分发",
          "position": {
            "x": 1800,
            "y": 230
          },
          "visualStyle": "output",
          "inputPorts": [
            {
              "id": "c3bf346d-48fa-4de1-8a42-678412a3ff91",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "3bf8b763-fec6-46dc-a139-cfbfc9f50ca2",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "bd0f67a5-31ee-4ed9-9218-9eb1d1b201a3",
          "title": "Web 回复",
          "subtitle": "Web 会话输出",
          "position": {
            "x": 2100,
            "y": 120
          },
          "visualStyle": "output",
          "inputPorts": [
            {
              "id": "ba4f17fd-069e-4a4a-ab9c-e8c7758b763d",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "de617ed2-c753-45ce-b2ca-b59a9a38c908",
              "name": "输出"
            }
          ]
        },
        {
          "id": "60412e93-7fe3-4999-a106-7473b1001c5a",
          "title": "QQ 回复",
          "subtitle": "QQ 平台回复 · 被动发送",
          "position": {
            "x": 2100,
            "y": 340
          },
          "visualStyle": "output",
          "inputPorts": [
            {
              "id": "a94d6107-184e-4ddb-840e-bca0a3a1de65",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "45d8a708-b295-4f43-b3ca-84cce5cc66a6",
              "name": "输出"
            }
          ],
          "childBoardId": "92a093d6-a325-4d0f-a263-8809bf26b370"
        }
      ],
      "edges": [
        {
          "id": "c8a57ccc-27e6-4d21-82e6-7c3f9e603a46",
          "fromNodeId": "b44c8df7-ddcb-4d94-9555-31946ee3ed89",
          "fromPortId": "a2142584-5536-4800-817b-6bee9968d7f8",
          "toNodeId": "0c39c13d-96b2-4f1d-8f78-20d25fb2eb3b",
          "toPortId": "75c5d245-f8be-4a66-a046-d13dcdc9055c",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "trigger"
        },
        {
          "id": "9a719cf1-5982-45a7-83c8-616260668a8b",
          "fromNodeId": "fe3e3f19-b477-4e28-8508-0e505234abd3",
          "fromPortId": "647495e8-6826-48b5-9292-5504d71a5efe",
          "toNodeId": "56b01adb-4fe9-484b-b9cc-3736ed459cb5",
          "toPortId": "6eaf0ad8-0365-40be-a3e6-cd586c402511",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "trigger"
        },
        {
          "id": "544df1d0-5c8f-4121-9f6c-c16f502b4b88",
          "fromNodeId": "0c39c13d-96b2-4f1d-8f78-20d25fb2eb3b",
          "fromPortId": "e201db4d-4193-4cc1-b4ac-321e4f46b499",
          "toNodeId": "57babe78-9d81-4fca-aee4-721f872cca8a",
          "toPortId": "f9ef81c4-3d4c-49ef-a0a9-d975cf16ba11",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "data"
        },
        {
          "id": "be19c9e4-46eb-4921-87a1-1cbbac3610c8",
          "fromNodeId": "56b01adb-4fe9-484b-b9cc-3736ed459cb5",
          "fromPortId": "809d97ed-22f7-4e23-afb3-d6a8a0479cdd",
          "toNodeId": "57babe78-9d81-4fca-aee4-721f872cca8a",
          "toPortId": "f9ef81c4-3d4c-49ef-a0a9-d975cf16ba11",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "data"
        },
        {
          "id": "c0b05d55-7ea0-4773-8833-931b1c2a95c2",
          "fromNodeId": "57babe78-9d81-4fca-aee4-721f872cca8a",
          "fromPortId": "797d2af2-ebd3-4830-9dbb-2dd0452c67ee",
          "toNodeId": "4cebf490-3782-4380-91c7-8ee4689dcc71",
          "toPortId": "915b9840-3c75-4274-9f88-126c7d7e18c4",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "data"
        },
        {
          "id": "c510ff40-c0e2-46d3-9d6a-2668c70074df",
          "fromNodeId": "4cebf490-3782-4380-91c7-8ee4689dcc71",
          "fromPortId": "786326dc-ef4b-4cc8-beb0-870309593367",
          "toNodeId": "541e3489-0cf7-4e14-a0a0-819d7e101fe3",
          "toPortId": "68e66a6a-5707-4af2-8f9c-2a758d7b9417",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "data"
        },
        {
          "id": "dca8a72a-d464-44c2-a848-df9f4c6b7db3",
          "fromNodeId": "454e45b2-0c94-43b1-ab5d-d4c6eac90eb7",
          "fromPortId": "b70e028a-9f02-402d-94a9-33ef9ae16353",
          "toNodeId": "541e3489-0cf7-4e14-a0a0-819d7e101fe3",
          "toPortId": "09fddd07-f175-4b61-9813-6744c3a8da44",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "bezier"
          },
          "semantic": "capability"
        },
        {
          "id": "49894254-069c-4f48-aa86-4b6c560d20b5",
          "fromNodeId": "027048c7-b2ad-4bf3-ae1f-941ebb4c4c13",
          "fromPortId": "69499ac7-11fe-47e5-932c-93850d1af45c",
          "toNodeId": "57643ae7-5ee6-403b-b184-d72636a42fe0",
          "toPortId": "1a2f14d1-007e-4669-bf0d-62ae7226d8da",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "bezier"
          },
          "semantic": "optional"
        },
        {
          "id": "66b12238-7043-455a-9c5e-4effbb70dd8b",
          "fromNodeId": "57643ae7-5ee6-403b-b184-d72636a42fe0",
          "fromPortId": "1a34d660-714d-4641-b76f-369ff35b9c77",
          "toNodeId": "541e3489-0cf7-4e14-a0a0-819d7e101fe3",
          "toPortId": "09fddd07-f175-4b61-9813-6744c3a8da44",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "bezier"
          },
          "semantic": "capability"
        },
        {
          "id": "147ee9c1-30a0-44cf-9330-ebeac530cbc9",
          "fromNodeId": "541e3489-0cf7-4e14-a0a0-819d7e101fe3",
          "fromPortId": "f8858807-49ce-4758-9fd9-ce63cf585a50",
          "toNodeId": "31e0329e-81ca-45f5-b61d-9c272ce7f1f3",
          "toPortId": "a462b5ef-d014-4dc0-8ca2-6c982f8f0b0b",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "bezier"
          },
          "semantic": "optional"
        },
        {
          "id": "8b6543af-1ebf-4b61-a8bf-2552294a03cb",
          "fromNodeId": "31e0329e-81ca-45f5-b61d-9c272ce7f1f3",
          "fromPortId": "57bdb3a2-cc19-4591-9c11-210c546ce173",
          "toNodeId": "57643ae7-5ee6-403b-b184-d72636a42fe0",
          "toPortId": "36f37f5d-5f99-4c70-9291-a8754306fedf",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "trigger"
        },
        {
          "id": "a41fb156-1d62-4e25-b9bb-afcedcb2f995",
          "fromNodeId": "57643ae7-5ee6-403b-b184-d72636a42fe0",
          "fromPortId": "e5e0adc8-01bc-4d79-aa87-ddabb2329879",
          "toNodeId": "541e3489-0cf7-4e14-a0a0-819d7e101fe3",
          "toPortId": "d5ac0ab1-e981-4f5c-b6e3-42bbc988cd30",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "orthogonal"
          },
          "semantic": "feedback"
        },
        {
          "id": "a93c9986-daf4-4535-af43-7647500145a9",
          "fromNodeId": "541e3489-0cf7-4e14-a0a0-819d7e101fe3",
          "fromPortId": "3efafe18-3695-48e2-9890-751c9bf4ea19",
          "toNodeId": "09f840cb-c3d1-4846-8fa1-d1efcaf1d935",
          "toPortId": "c3bf346d-48fa-4de1-8a42-678412a3ff91",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "orthogonal"
          },
          "semantic": "data"
        },
        {
          "id": "d90c964e-fdd2-4dca-abfa-8d9c652baceb",
          "fromNodeId": "09f840cb-c3d1-4846-8fa1-d1efcaf1d935",
          "fromPortId": "3bf8b763-fec6-46dc-a139-cfbfc9f50ca2",
          "toNodeId": "bd0f67a5-31ee-4ed9-9218-9eb1d1b201a3",
          "toPortId": "ba4f17fd-069e-4a4a-ab9c-e8c7758b763d",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "data"
        },
        {
          "id": "43f52018-e3b7-4c2c-a8be-c27d1816cab1",
          "fromNodeId": "09f840cb-c3d1-4846-8fa1-d1efcaf1d935",
          "fromPortId": "3bf8b763-fec6-46dc-a139-cfbfc9f50ca2",
          "toNodeId": "60412e93-7fe3-4999-a106-7473b1001c5a",
          "toPortId": "a94d6107-184e-4ddb-840e-bca0a3a1de65",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "data"
        }
      ],
      "viewport": null
    },
    {
      "id": "0ea36c05-8e6f-4782-8110-e90b4e8f1e82",
      "name": "上下文",
      "nodes": [
        {
          "id": "8cc877c9-cee5-42ef-94a8-b932860ab062",
          "title": "QQ 上下文",
          "subtitle": "当前消息 · 历史接入规划",
          "position": {
            "x": 0,
            "y": 0
          },
          "visualStyle": "input",
          "inputPorts": [
            {
              "id": "b4a27394-7815-4673-a912-fb530a80d7cc",
              "name": "输入"
            }
          ],
          "outputPorts": [
            {
              "id": "ef53844c-31c0-4a19-81ab-f444a7653dcd",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "a7d81105-fad9-4833-9c33-850e40c3c2cb",
          "title": "Web 近期上下文",
          "subtitle": "现有会话近期消息",
          "position": {
            "x": 0,
            "y": 220
          },
          "visualStyle": "input",
          "inputPorts": [
            {
              "id": "9cb36a1b-ef04-4c80-afea-967cb122bf87",
              "name": "输入"
            }
          ],
          "outputPorts": [
            {
              "id": "97512b1f-24ad-4ed3-b495-935f839792f5",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "c905d233-f443-4cd3-bc07-b2c9bca19f12",
          "title": "上下文准备",
          "subtitle": "来源隔离 · 按预算组装",
          "position": {
            "x": 300,
            "y": 110
          },
          "visualStyle": "context",
          "inputPorts": [
            {
              "id": "9443a510-0f25-47bc-ae34-deec4ae868c2",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "7c346771-9534-4998-90b8-759797b2ea5f",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "6a76d4b9-5f9b-42cf-84c3-300f712fd3b2",
          "title": "完整短期上下文",
          "subtitle": "目标 · 原始近期消息",
          "position": {
            "x": 600,
            "y": 80
          },
          "visualStyle": "context",
          "inputPorts": [
            {
              "id": "90773a6d-7ade-451a-a4fd-e0181311adab",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "2568e2d8-38c4-4c39-9acb-0f19e24c2c21",
              "name": "输出",
              "side": "right"
            },
            {
              "id": "78e01789-45e0-4afc-ae9f-4db4ff4527ee",
              "name": "输出",
              "side": "bottom"
            }
          ]
        },
        {
          "id": "dc70e1e1-3e59-4ae5-94a6-f76176627d73",
          "title": "输出：模型",
          "subtitle": "近期信息直接提供",
          "position": {
            "x": 1200,
            "y": 80
          },
          "visualStyle": "output",
          "inputPorts": [
            {
              "id": "5c75f45c-c242-49bf-bb3e-3bf0b9086cef",
              "name": "输入",
              "side": "left"
            },
            {
              "id": "a938bb86-aa8f-4fa5-9c9d-5e94dcb3d490",
              "name": "输入",
              "side": "bottom"
            },
            {
              "id": "cc1552fb-fe91-4547-b1ad-a10a8be646ac",
              "name": "输入",
              "side": "top"
            }
          ],
          "outputPorts": [
            {
              "id": "2b72c430-2e1c-4bfa-a578-002f9092ab39",
              "name": "输出"
            }
          ]
        },
        {
          "id": "7f2d2f60-facd-4a67-824d-0d4d979c116c",
          "title": "退出短期窗口",
          "subtitle": "旧消息 · 规划中",
          "position": {
            "x": 600,
            "y": 340
          },
          "visualStyle": "context",
          "inputPorts": [
            {
              "id": "f981a4e9-4082-45d1-84e7-400784634402",
              "name": "输入",
              "side": "top"
            }
          ],
          "outputPorts": [
            {
              "id": "a041c456-15f7-4a32-abf0-ae09d27eaf4d",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "920fae8e-83b8-42c6-962c-c63fd5cdca68",
          "title": "上下文压缩",
          "subtitle": "规划中 · 可选后台处理",
          "position": {
            "x": 900,
            "y": 340
          },
          "visualStyle": "prompt",
          "inputPorts": [
            {
              "id": "5faecf81-d3aa-44d5-9067-c5d4d51ac865",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "3cf27653-223f-4731-a5e8-ffa14556cc5a",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "c1e442f8-ca41-45d9-a657-dfaa15a59f19",
          "title": "普通压缩上下文池",
          "subtitle": "规划中 · 非每轮压缩",
          "position": {
            "x": 1200,
            "y": 340
          },
          "visualStyle": "context",
          "inputPorts": [
            {
              "id": "4f8c70c5-7c19-4d45-9356-d91e7b6aff1b",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "a9c5f02b-600e-4aee-af90-3da818c2872e",
              "name": "输出",
              "side": "top"
            }
          ]
        },
        {
          "id": "1ec911bf-d4bf-4d99-a023-d6a1f697ba31",
          "title": "长期记忆",
          "subtitle": "未来规划 · 尚未实现",
          "position": {
            "x": 900,
            "y": 610
          },
          "visualStyle": "context",
          "inputPorts": [
            {
              "id": "a965f6d3-7073-4093-8530-42003c978ee8",
              "name": "输入"
            }
          ],
          "outputPorts": [
            {
              "id": "9c5af1d5-806a-4659-b7a0-993ea6656ccc",
              "name": "输出"
            }
          ]
        }
      ],
      "edges": [
        {
          "id": "ef393f59-faab-44bd-8428-4533535f24ab",
          "fromNodeId": "8cc877c9-cee5-42ef-94a8-b932860ab062",
          "fromPortId": "ef53844c-31c0-4a19-81ab-f444a7653dcd",
          "toNodeId": "c905d233-f443-4cd3-bc07-b2c9bca19f12",
          "toPortId": "9443a510-0f25-47bc-ae34-deec4ae868c2",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "data"
        },
        {
          "id": "753d78e8-b1f9-4e38-a521-465234afc92e",
          "fromNodeId": "a7d81105-fad9-4833-9c33-850e40c3c2cb",
          "fromPortId": "97512b1f-24ad-4ed3-b495-935f839792f5",
          "toNodeId": "c905d233-f443-4cd3-bc07-b2c9bca19f12",
          "toPortId": "9443a510-0f25-47bc-ae34-deec4ae868c2",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "data"
        },
        {
          "id": "3d00248d-cbcc-410f-991e-c9db756014f2",
          "fromNodeId": "c905d233-f443-4cd3-bc07-b2c9bca19f12",
          "fromPortId": "7c346771-9534-4998-90b8-759797b2ea5f",
          "toNodeId": "6a76d4b9-5f9b-42cf-84c3-300f712fd3b2",
          "toPortId": "90773a6d-7ade-451a-a4fd-e0181311adab",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "data"
        },
        {
          "id": "2fd73aa5-d32d-4a8e-854b-51d618909378",
          "fromNodeId": "6a76d4b9-5f9b-42cf-84c3-300f712fd3b2",
          "fromPortId": "2568e2d8-38c4-4c39-9acb-0f19e24c2c21",
          "toNodeId": "dc70e1e1-3e59-4ae5-94a6-f76176627d73",
          "toPortId": "5c75f45c-c242-49bf-bb3e-3bf0b9086cef",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "data"
        },
        {
          "id": "de48a35a-5f6d-481d-8823-627eaef2bc2b",
          "fromNodeId": "6a76d4b9-5f9b-42cf-84c3-300f712fd3b2",
          "fromPortId": "78e01789-45e0-4afc-ae9f-4db4ff4527ee",
          "toNodeId": "7f2d2f60-facd-4a67-824d-0d4d979c116c",
          "toPortId": "f981a4e9-4082-45d1-84e7-400784634402",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "bezier"
          },
          "semantic": "optional"
        },
        {
          "id": "854b1493-3bdb-4555-bb04-b514121b4e71",
          "fromNodeId": "7f2d2f60-facd-4a67-824d-0d4d979c116c",
          "fromPortId": "a041c456-15f7-4a32-abf0-ae09d27eaf4d",
          "toNodeId": "920fae8e-83b8-42c6-962c-c63fd5cdca68",
          "toPortId": "5faecf81-d3aa-44d5-9067-c5d4d51ac865",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "bezier"
          },
          "semantic": "optional"
        },
        {
          "id": "ce76f4b5-a916-4ed0-b2d8-d56db5051098",
          "fromNodeId": "920fae8e-83b8-42c6-962c-c63fd5cdca68",
          "fromPortId": "3cf27653-223f-4731-a5e8-ffa14556cc5a",
          "toNodeId": "c1e442f8-ca41-45d9-a657-dfaa15a59f19",
          "toPortId": "4f8c70c5-7c19-4d45-9356-d91e7b6aff1b",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "bezier"
          },
          "semantic": "optional"
        },
        {
          "id": "74b4f409-4910-4fd9-9025-49c111929c8a",
          "fromNodeId": "c1e442f8-ca41-45d9-a657-dfaa15a59f19",
          "fromPortId": "a9c5f02b-600e-4aee-af90-3da818c2872e",
          "toNodeId": "dc70e1e1-3e59-4ae5-94a6-f76176627d73",
          "toPortId": "a938bb86-aa8f-4fa5-9c9d-5e94dcb3d490",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "orthogonal"
          },
          "semantic": "optional"
        }
      ],
      "viewport": null
    },
    {
      "id": "cbc34832-7368-445a-9743-9fdc94bcb14d",
      "name": "Skill",
      "nodes": [
        {
          "id": "7ff3aea3-24ca-4a60-b58d-5e6ff249f47f",
          "title": "Excel Skill",
          "subtitle": "示例 · 正文内容待接入",
          "position": {
            "x": 0,
            "y": 0
          },
          "visualStyle": "prompt",
          "inputPorts": [
            {
              "id": "05538d67-670f-4c42-aba8-12ef9c6c4b9c",
              "name": "输入"
            }
          ],
          "outputPorts": [
            {
              "id": "936e15f4-a6ba-497a-a41d-a552d08ecbaf",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "17a9fbc3-07cd-4f10-9ade-ff44c402a4a5",
          "title": "Word Skill",
          "subtitle": "示例 · 正文内容待接入",
          "position": {
            "x": 0,
            "y": 190
          },
          "visualStyle": "prompt",
          "inputPorts": [
            {
              "id": "c43040e7-c456-41a2-bcde-86c6701e5379",
              "name": "输入"
            }
          ],
          "outputPorts": [
            {
              "id": "5d2f5cf5-e32a-49d1-8f3b-ff079f8f144b",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "bbd2b2a0-ed37-4b63-abd1-e1ed82ec2398",
          "title": "QQ msg Skill",
          "subtitle": "规划示例 · 当前无内置正文",
          "position": {
            "x": 0,
            "y": 380
          },
          "visualStyle": "prompt",
          "inputPorts": [
            {
              "id": "cf0e0398-2bc2-4376-a138-2c7b8ce33880",
              "name": "输入"
            }
          ],
          "outputPorts": [
            {
              "id": "0cb0256c-b74e-49ba-b4ec-cd6594ff36e1",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "0c5de3cb-06bd-4478-895c-cd02234517f9",
          "title": "Skill 注册与索引",
          "subtitle": "声明、可信绑定、启用状态",
          "position": {
            "x": 300,
            "y": 190
          },
          "visualStyle": "prompt",
          "inputPorts": [
            {
              "id": "9e4e5ef8-9733-415c-8a15-1a83241df1a8",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "ed76231c-e522-43c8-8eb1-f2935acec257",
              "name": "输出",
              "side": "right"
            },
            {
              "id": "698ca986-b3a1-4fae-8b59-b34e14e930ee",
              "name": "输出",
              "side": "bottom"
            }
          ]
        },
        {
          "id": "1fb63918-65db-482f-90b5-4be88e7a32c6",
          "title": "选择 Skill",
          "subtitle": "Web 开关控制 · 关键词 / 显式引用",
          "position": {
            "x": 600,
            "y": 190
          },
          "visualStyle": "prompt",
          "inputPorts": [
            {
              "id": "34a8b788-9177-420c-a216-d9be56e26ea4",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "31932583-7281-4cd2-acae-17a7663f195a",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "fe47eacc-cf4b-4870-ac0f-87f252ebeea7",
          "title": "加载与预算",
          "subtitle": "匹配项正文 · 可信校验",
          "position": {
            "x": 900,
            "y": 190
          },
          "visualStyle": "prompt",
          "inputPorts": [
            {
              "id": "505640f7-52dc-4241-a66b-65cd4871a6bd",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "cf33f442-215d-4748-8723-458420ce8568",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "7f00562b-35b1-4f7b-acc4-3407a7ee27eb",
          "title": "提供给模型",
          "subtitle": "现阶段注入所选正文",
          "position": {
            "x": 1200,
            "y": 190
          },
          "visualStyle": "output",
          "inputPorts": [
            {
              "id": "ccbb38be-4b40-4861-9d90-3a7d481228ea",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "ed77ed11-67c2-4c2a-bb50-9b7b065c926c",
              "name": "输出"
            }
          ]
        },
        {
          "id": "bda39050-39c5-4be6-a7cb-d14afc4cf28c",
          "title": "模型自主读取",
          "subtitle": "未来目标 · 索引与按需读取",
          "position": {
            "x": 600,
            "y": 450
          },
          "visualStyle": "prompt",
          "inputPorts": [
            {
              "id": "5a943214-2d99-4b64-a4c9-a177d7f8f616",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "0f0ef88e-a54f-481d-af6e-e17b0580b02e",
              "name": "输出"
            }
          ]
        }
      ],
      "edges": [
        {
          "id": "c60128b6-4ddd-48f8-ab50-3544ec9c71bb",
          "fromNodeId": "7ff3aea3-24ca-4a60-b58d-5e6ff249f47f",
          "fromPortId": "936e15f4-a6ba-497a-a41d-a552d08ecbaf",
          "toNodeId": "0c5de3cb-06bd-4478-895c-cd02234517f9",
          "toPortId": "9e4e5ef8-9733-415c-8a15-1a83241df1a8",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "bezier"
          },
          "semantic": "capability"
        },
        {
          "id": "c5c54b9c-7668-4a49-9125-437390322c42",
          "fromNodeId": "17a9fbc3-07cd-4f10-9ade-ff44c402a4a5",
          "fromPortId": "5d2f5cf5-e32a-49d1-8f3b-ff079f8f144b",
          "toNodeId": "0c5de3cb-06bd-4478-895c-cd02234517f9",
          "toPortId": "9e4e5ef8-9733-415c-8a15-1a83241df1a8",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "bezier"
          },
          "semantic": "capability"
        },
        {
          "id": "2b7195bb-37bc-47d6-a305-2cd2a6e1487f",
          "fromNodeId": "bbd2b2a0-ed37-4b63-abd1-e1ed82ec2398",
          "fromPortId": "0cb0256c-b74e-49ba-b4ec-cd6594ff36e1",
          "toNodeId": "0c5de3cb-06bd-4478-895c-cd02234517f9",
          "toPortId": "9e4e5ef8-9733-415c-8a15-1a83241df1a8",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "bezier"
          },
          "semantic": "capability"
        },
        {
          "id": "c5563a0a-cbe2-4cbe-915a-9cf60856d07f",
          "fromNodeId": "0c5de3cb-06bd-4478-895c-cd02234517f9",
          "fromPortId": "ed76231c-e522-43c8-8eb1-f2935acec257",
          "toNodeId": "1fb63918-65db-482f-90b5-4be88e7a32c6",
          "toPortId": "34a8b788-9177-420c-a216-d9be56e26ea4",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "bezier"
          },
          "semantic": "optional"
        },
        {
          "id": "c98ad22d-6034-4443-bf1d-968c80b2f1b1",
          "fromNodeId": "1fb63918-65db-482f-90b5-4be88e7a32c6",
          "fromPortId": "31932583-7281-4cd2-acae-17a7663f195a",
          "toNodeId": "fe47eacc-cf4b-4870-ac0f-87f252ebeea7",
          "toPortId": "505640f7-52dc-4241-a66b-65cd4871a6bd",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "bezier"
          },
          "semantic": "optional"
        },
        {
          "id": "9a9795fe-3eac-45eb-a61a-b70148690864",
          "fromNodeId": "fe47eacc-cf4b-4870-ac0f-87f252ebeea7",
          "fromPortId": "cf33f442-215d-4748-8723-458420ce8568",
          "toNodeId": "7f00562b-35b1-4f7b-acc4-3407a7ee27eb",
          "toPortId": "ccbb38be-4b40-4861-9d90-3a7d481228ea",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "bezier"
          },
          "semantic": "optional"
        },
        {
          "id": "380f1a9c-d3ce-4ce7-a751-5378f01b20b7",
          "fromNodeId": "0c5de3cb-06bd-4478-895c-cd02234517f9",
          "fromPortId": "698ca986-b3a1-4fae-8b59-b34e14e930ee",
          "toNodeId": "bda39050-39c5-4be6-a7cb-d14afc4cf28c",
          "toPortId": "5a943214-2d99-4b64-a4c9-a177d7f8f616",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "orthogonal"
          },
          "semantic": "optional"
        }
      ],
      "viewport": null
    },
    {
      "id": "e8923e0d-e64f-4009-bac1-a0337714d606",
      "name": "Tool",
      "nodes": [
        {
          "id": "596ac07d-10ce-49db-83ef-d37f28d12ae2",
          "title": "QQ msg Tool",
          "subtitle": "已注册 · 主动发送须审批",
          "position": {
            "x": 0,
            "y": 0
          },
          "visualStyle": "tool",
          "inputPorts": [
            {
              "id": "f93d6e1f-849c-4a3e-8c45-a8c55c19e914",
              "name": "输入"
            }
          ],
          "outputPorts": [
            {
              "id": "dc22b514-2ba7-49b5-83fe-2b4c3675afdc",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "fbb37480-5bdd-4cab-b8f6-36a16c344a99",
          "title": "其他 Tool",
          "subtitle": "注册能力与模型可见定义",
          "position": {
            "x": 0,
            "y": 190
          },
          "visualStyle": "tool",
          "inputPorts": [
            {
              "id": "356b6af7-3730-49c3-bc25-11cc11129a4b",
              "name": "输入"
            }
          ],
          "outputPorts": [
            {
              "id": "18ed182c-bbed-4860-8ad7-16567420ad09",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "e70d7a63-415d-403f-9170-6ef2309752a8",
          "title": "可用性检查",
          "subtitle": "Web · 能力与 Core 配置",
          "position": {
            "x": 300,
            "y": 80
          },
          "visualStyle": "tool",
          "inputPorts": [
            {
              "id": "4bf4a217-ea5b-44f7-8da8-6c4ccd56cb85",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "8bebef98-4b80-460e-bc1e-096cdc6d81bc",
              "name": "输出",
              "side": "bottom"
            }
          ]
        },
        {
          "id": "b4885fd8-b903-4d39-8ee4-d9d3bae8cc0f",
          "title": "模型发起 Tool Call",
          "subtitle": "可选 · 按需调用",
          "position": {
            "x": 300,
            "y": 310
          },
          "visualStyle": "model",
          "inputPorts": [
            {
              "id": "45310c16-df0b-423b-814c-47a65166f24a",
              "name": "输入",
              "side": "top"
            }
          ],
          "outputPorts": [
            {
              "id": "b3cd457e-8ae1-4303-9b91-2a94b91e8d70",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "59a97ff1-298f-49bd-99a1-8d682295c927",
          "title": "参数与权限校验",
          "subtitle": "Core 检查 · 禁止绕过",
          "position": {
            "x": 600,
            "y": 310
          },
          "visualStyle": "tool",
          "inputPorts": [
            {
              "id": "60fb86c7-9643-4748-af54-75c6fe135105",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "03e5c5a1-6b77-42c2-af8c-5e49b7f61660",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "ae4431ee-1bbc-433d-82ee-cf746e63af09",
          "title": "用户审批",
          "subtitle": "需要时等待批准",
          "position": {
            "x": 900,
            "y": 310
          },
          "visualStyle": "tool",
          "inputPorts": [
            {
              "id": "55508be3-36b0-4e5f-8ac8-1623e465d3e9",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "12de1918-ad64-4116-a718-3c2a97455ca0",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "a46003b4-eee3-4fd0-bcaf-aee8251a2f1f",
          "title": "实际执行",
          "subtitle": "获准后调用 Tool",
          "position": {
            "x": 1200,
            "y": 230
          },
          "visualStyle": "tool",
          "inputPorts": [
            {
              "id": "12684265-2ef5-4a11-9777-4fc336816c29",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "5ff08f87-1adb-4c2e-a1c3-8ca4d10c8a2f",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "2d1b56ee-16b7-464a-bc11-46b858c9582d",
          "title": "拒绝 / 失败",
          "subtitle": "返回失败或拒绝结果",
          "position": {
            "x": 1200,
            "y": 430
          },
          "visualStyle": "tool",
          "inputPorts": [
            {
              "id": "09b922ca-b834-43ab-85ed-9376e2ccb840",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "fb9512e9-d387-4eea-8934-d53918396aa7",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "d034b72c-cb27-4da2-8e7b-780b46ec1eb7",
          "title": "Tool Result",
          "subtitle": "成功 / 失败反馈模型",
          "position": {
            "x": 1500,
            "y": 310
          },
          "visualStyle": "output",
          "inputPorts": [
            {
              "id": "3a7c668f-220a-42d6-b1c4-a37d45d55af6",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "fa44dd59-bbf1-4a95-8184-2757c3512442",
              "name": "输出"
            }
          ]
        }
      ],
      "edges": [
        {
          "id": "03754107-948f-40f6-a549-ba46eecdbd56",
          "fromNodeId": "596ac07d-10ce-49db-83ef-d37f28d12ae2",
          "fromPortId": "dc22b514-2ba7-49b5-83fe-2b4c3675afdc",
          "toNodeId": "e70d7a63-415d-403f-9170-6ef2309752a8",
          "toPortId": "4bf4a217-ea5b-44f7-8da8-6c4ccd56cb85",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "bezier"
          },
          "semantic": "capability"
        },
        {
          "id": "6d87fa76-5a84-4674-a528-9020148b57eb",
          "fromNodeId": "fbb37480-5bdd-4cab-b8f6-36a16c344a99",
          "fromPortId": "18ed182c-bbed-4860-8ad7-16567420ad09",
          "toNodeId": "e70d7a63-415d-403f-9170-6ef2309752a8",
          "toPortId": "4bf4a217-ea5b-44f7-8da8-6c4ccd56cb85",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "bezier"
          },
          "semantic": "capability"
        },
        {
          "id": "9b4e54de-bbcf-4762-8cef-1e64734d90f4",
          "fromNodeId": "e70d7a63-415d-403f-9170-6ef2309752a8",
          "fromPortId": "8bebef98-4b80-460e-bc1e-096cdc6d81bc",
          "toNodeId": "b4885fd8-b903-4d39-8ee4-d9d3bae8cc0f",
          "toPortId": "45310c16-df0b-423b-814c-47a65166f24a",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "bezier"
          },
          "semantic": "capability"
        },
        {
          "id": "829d7dc3-5d74-4b11-bcba-630c9713c519",
          "fromNodeId": "b4885fd8-b903-4d39-8ee4-d9d3bae8cc0f",
          "fromPortId": "b3cd457e-8ae1-4303-9b91-2a94b91e8d70",
          "toNodeId": "59a97ff1-298f-49bd-99a1-8d682295c927",
          "toPortId": "60fb86c7-9643-4748-af54-75c6fe135105",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "trigger"
        },
        {
          "id": "493244f4-968a-489f-ac8c-a76829dbe8ee",
          "fromNodeId": "59a97ff1-298f-49bd-99a1-8d682295c927",
          "fromPortId": "03e5c5a1-6b77-42c2-af8c-5e49b7f61660",
          "toNodeId": "ae4431ee-1bbc-433d-82ee-cf746e63af09",
          "toPortId": "55508be3-36b0-4e5f-8ac8-1623e465d3e9",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "trigger"
        },
        {
          "id": "bce44337-d96b-495f-ba41-299d971559de",
          "fromNodeId": "ae4431ee-1bbc-433d-82ee-cf746e63af09",
          "fromPortId": "12de1918-ad64-4116-a718-3c2a97455ca0",
          "toNodeId": "a46003b4-eee3-4fd0-bcaf-aee8251a2f1f",
          "toPortId": "12684265-2ef5-4a11-9777-4fc336816c29",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "bezier"
          },
          "semantic": "optional"
        },
        {
          "id": "2435d84d-f6e5-401e-a2ff-6c0a878f33ed",
          "fromNodeId": "ae4431ee-1bbc-433d-82ee-cf746e63af09",
          "fromPortId": "12de1918-ad64-4116-a718-3c2a97455ca0",
          "toNodeId": "2d1b56ee-16b7-464a-bc11-46b858c9582d",
          "toPortId": "09b922ca-b834-43ab-85ed-9376e2ccb840",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "bezier"
          },
          "semantic": "optional"
        },
        {
          "id": "76c1b4e5-317e-475a-8c70-13f257b404c9",
          "fromNodeId": "a46003b4-eee3-4fd0-bcaf-aee8251a2f1f",
          "fromPortId": "5ff08f87-1adb-4c2e-a1c3-8ca4d10c8a2f",
          "toNodeId": "d034b72c-cb27-4da2-8e7b-780b46ec1eb7",
          "toPortId": "3a7c668f-220a-42d6-b1c4-a37d45d55af6",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "feedback"
        },
        {
          "id": "22b97e36-2895-409d-9c06-ed813411b263",
          "fromNodeId": "2d1b56ee-16b7-464a-bc11-46b858c9582d",
          "fromPortId": "fb9512e9-d387-4eea-8934-d53918396aa7",
          "toNodeId": "d034b72c-cb27-4da2-8e7b-780b46ec1eb7",
          "toPortId": "3a7c668f-220a-42d6-b1c4-a37d45d55af6",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "feedback"
        }
      ],
      "viewport": null
    },
    {
      "id": "92a093d6-a325-4d0f-a263-8809bf26b370",
      "name": "QQ 星核",
      "nodes": [
        {
          "id": "48f62129-8b3a-434e-914f-9d0b68623905",
          "title": "QQ 消息接收",
          "subtitle": "私聊 / 群聊消息",
          "position": {
            "x": 0,
            "y": 0
          },
          "visualStyle": "input",
          "inputPorts": [
            {
              "id": "513d5fd9-4888-446a-83b7-513bae0c4b48",
              "name": "输入"
            }
          ],
          "outputPorts": [
            {
              "id": "d39e25f1-a878-48ad-8c26-424f23f6ff24",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "7e6dbc28-3d30-4e58-ae52-55b21ebcb8d7",
          "title": "输入过滤",
          "subtitle": "群聊需 @ · 去重 / 限速",
          "position": {
            "x": 300,
            "y": 0
          },
          "visualStyle": "input",
          "inputPorts": [
            {
              "id": "9d5dd08e-8730-4b55-9a6b-205317853bec",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "ad566547-1448-44e1-aeab-ba6461aca1f7",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "bd9dc640-65d3-4997-a9af-b9f23991e0f2",
          "title": "输出：QQ 上下文",
          "subtitle": "当前消息 · 提供给主流程",
          "position": {
            "x": 600,
            "y": 0
          },
          "visualStyle": "context",
          "inputPorts": [
            {
              "id": "167158e0-437d-4168-b456-8218255bec74",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "2ff6d93b-72f1-4c4f-8598-a13e608b00a1",
              "name": "输出"
            },
            {
              "id": "00be57f2-0490-4cd0-9003-d78178c00faa",
              "name": "输出",
              "side": "top"
            }
          ]
        },
        {
          "id": "89b8561d-0d3b-43ae-a6b5-c1ae812c3d24",
          "title": "QQ msg Tool",
          "subtitle": "主动发送 · Core 审批",
          "position": {
            "x": 300,
            "y": 520
          },
          "visualStyle": "tool",
          "inputPorts": [
            {
              "id": "d40aec5c-a924-47ea-850e-58b3d2363295",
              "name": "输入"
            }
          ],
          "outputPorts": [
            {
              "id": "0e8868bd-eed8-48bb-8b3c-140b38c019fa",
              "name": "输出"
            },
            {
              "id": "2e218201-0600-4f05-be30-41d8c903030a",
              "name": "输出",
              "side": "bottom"
            },
            {
              "id": "92c170b6-dafc-4934-b0d0-977d0bf2921b",
              "name": "输出",
              "side": "bottom"
            },
            {
              "id": "32fabcf3-5e0b-437e-8a47-9b0eb2444942",
              "name": "主动发送",
              "side": "top"
            }
          ]
        },
        {
          "id": "067b1364-819a-49f2-8cc2-11d43c53b1be",
          "title": "QQ msg Skill / 规则",
          "subtitle": "Skill 正文规划 · 当前无内置",
          "position": {
            "x": 0,
            "y": -260
          },
          "visualStyle": "prompt",
          "inputPorts": [
            {
              "id": "47f47bb8-7ff7-41a5-b149-f4ea9229fd3c",
              "name": "输入"
            },
            {
              "id": "2f16a12a-b4d0-4ce0-a8c5-0361d7d11d14",
              "name": "输入",
              "side": "bottom"
            }
          ],
          "outputPorts": [
            {
              "id": "b42adff1-5574-44e6-8e1d-950b12daf988",
              "name": "输出",
              "side": "top"
            }
          ]
        },
        {
          "id": "f27826ac-b890-408a-bbc9-58833fc33e42",
          "title": "输入：主流程回复",
          "subtitle": "本轮回复 · 格式适配",
          "position": {
            "x": 0,
            "y": 260
          },
          "visualStyle": "output",
          "inputPorts": [
            {
              "id": "1b85c500-d2cd-44ff-85fc-0a26fe1662ea",
              "name": "输入",
              "side": "bottom"
            },
            {
              "id": "589b3eab-7783-44aa-8892-a464a64bfaa2",
              "name": "输入",
              "side": "top"
            }
          ],
          "outputPorts": [
            {
              "id": "b96fd719-d10a-432b-859d-30d642039547",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "c74f0b74-9a26-41f8-9fc0-b4a9a1be51e6",
          "title": "QQ 消息发送",
          "subtitle": "原路回复 / 已审批的主动发送",
          "position": {
            "x": 600,
            "y": 260
          },
          "visualStyle": "output",
          "inputPorts": [
            {
              "id": "616dc50e-9048-46b8-8ee0-f178f13b0123",
              "name": "输入",
              "side": "left"
            },
            {
              "id": "429ebe20-e066-4e16-84b5-6534e19fb74c",
              "name": "主动发送",
              "side": "bottom"
            }
          ],
          "outputPorts": [
            {
              "id": "596e39df-6895-4806-acc4-6084445f4199",
              "name": "输出"
            }
          ]
        },
        {
          "id": "1b7d5078-6e31-49b1-ac9f-9fc23b838b8f",
          "title": "Core 工具调用",
          "subtitle": "Web 可用时 · Core 审批",
          "position": {
            "x": 0,
            "y": 520
          },
          "visualStyle": "input",
          "inputPorts": [
            {
              "id": "a7277150-0d9e-460f-b66b-b65cdc84a567",
              "name": "输入"
            }
          ],
          "outputPorts": [
            {
              "id": "b485992f-3226-466a-803f-295ee82532e1",
              "name": "输出"
            }
          ]
        }
      ],
      "edges": [
        {
          "id": "57d095fb-e4da-47a9-8890-d17e8d12d17c",
          "fromNodeId": "48f62129-8b3a-434e-914f-9d0b68623905",
          "fromPortId": "d39e25f1-a878-48ad-8c26-424f23f6ff24",
          "toNodeId": "7e6dbc28-3d30-4e58-ae52-55b21ebcb8d7",
          "toPortId": "9d5dd08e-8730-4b55-9a6b-205317853bec",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "trigger"
        },
        {
          "id": "0de5858e-9d7d-4b36-a053-fdebff0299c0",
          "fromNodeId": "7e6dbc28-3d30-4e58-ae52-55b21ebcb8d7",
          "fromPortId": "ad566547-1448-44e1-aeab-ba6461aca1f7",
          "toNodeId": "bd9dc640-65d3-4997-a9af-b9f23991e0f2",
          "toPortId": "167158e0-437d-4168-b456-8218255bec74",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "data"
        },
        {
          "id": "9a357533-c90d-45fe-b50b-8b10fcf474b0",
          "fromNodeId": "f27826ac-b890-408a-bbc9-58833fc33e42",
          "fromPortId": "b96fd719-d10a-432b-859d-30d642039547",
          "toNodeId": "c74f0b74-9a26-41f8-9fc0-b4a9a1be51e6",
          "toPortId": "616dc50e-9048-46b8-8ee0-f178f13b0123",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "trigger"
        },
        {
          "id": "19051b29-63ff-40ee-9833-a63c2529aad2",
          "fromNodeId": "067b1364-819a-49f2-8cc2-11d43c53b1be",
          "fromPortId": "b42adff1-5574-44e6-8e1d-950b12daf988",
          "toNodeId": "f27826ac-b890-408a-bbc9-58833fc33e42",
          "toPortId": "1b85c500-d2cd-44ff-85fc-0a26fe1662ea",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "orthogonal"
          },
          "semantic": "optional"
        },
        {
          "id": "d6cae8d8-ac6d-49c3-b320-86d8d02ece82",
          "fromNodeId": "1b7d5078-6e31-49b1-ac9f-9fc23b838b8f",
          "fromPortId": "b485992f-3226-466a-803f-295ee82532e1",
          "toNodeId": "89b8561d-0d3b-43ae-a6b5-c1ae812c3d24",
          "toPortId": "d40aec5c-a924-47ea-850e-58b3d2363295",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "orthogonal"
          },
          "semantic": "trigger"
        },
        {
          "id": "be5af98f-bec4-424f-9152-ada829da68ac",
          "fromNodeId": "89b8561d-0d3b-43ae-a6b5-c1ae812c3d24",
          "fromPortId": "32fabcf3-5e0b-437e-8a47-9b0eb2444942",
          "toNodeId": "c74f0b74-9a26-41f8-9fc0-b4a9a1be51e6",
          "toPortId": "429ebe20-e066-4e16-84b5-6534e19fb74c",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "orthogonal"
          },
          "semantic": "optional"
        }
      ],
      "viewport": null
    },
    {
      "id": "37da47c7-4f12-47c1-b2bc-f674cff425b3",
      "name": "沙盒执行",
      "nodes": [
        {
          "id": "2677e3f8-e3a0-495d-b38b-c9fa2f3ee454",
          "title": "执行请求",
          "subtitle": "规划中 · 模型按需调用",
          "position": {
            "x": 0,
            "y": 140
          },
          "visualStyle": "input",
          "inputPorts": [
            {
              "id": "ac902586-0df4-4134-80b5-52ef1901a657",
              "name": "输入"
            }
          ],
          "outputPorts": [
            {
              "id": "ea11d456-f647-4c4b-a1b1-6c74db0fe0f3",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "a9604226-2a68-4a54-9504-f64badaacdba",
          "title": "沙盒 Tool",
          "subtitle": "规划中 · 外部能力入口",
          "position": {
            "x": 300,
            "y": 140
          },
          "visualStyle": "tool",
          "inputPorts": [
            {
              "id": "e2b66b05-1212-408e-936f-c87f815b15d9",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "e482222d-eec9-40bf-9765-f5a7b7b612d7",
              "name": "输出",
              "side": "right"
            },
            {
              "id": "9c791488-dc2d-4854-992d-5c94990e3d00",
              "name": "输出",
              "side": "bottom"
            }
          ]
        },
        {
          "id": "aea482ee-8f91-4854-8aef-94837a570741",
          "title": "执行参数",
          "subtitle": "规划中 · 请求与用法",
          "position": {
            "x": 300,
            "y": 380
          },
          "visualStyle": "tool",
          "inputPorts": [
            {
              "id": "d3410543-4d8a-4410-b1fd-bb95536a5659",
              "name": "输入"
            },
            {
              "id": "098f65b6-7c0b-4f0a-9af6-75e51849040f",
              "name": "输入",
              "side": "top"
            }
          ],
          "outputPorts": [
            {
              "id": "f7935fab-cef0-4048-9030-19f379298f66",
              "name": "输出",
              "side": "top"
            },
            {
              "id": "f9bdb7b5-6b36-4593-b89a-b23508a2e271",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "ba8b44ae-737e-4ffd-a45c-8744ef876205",
          "title": "审批辅助模型",
          "subtitle": "规划中 · 可选建议",
          "position": {
            "x": 600,
            "y": 380
          },
          "visualStyle": "model",
          "inputPorts": [
            {
              "id": "d67df945-68df-4e59-b054-baab66f068a3",
              "name": "输入"
            }
          ],
          "outputPorts": [
            {
              "id": "0fe7ca18-5554-4d4d-b1c0-4cadedce4500",
              "name": "输出",
              "side": "top"
            }
          ]
        },
        {
          "id": "095a6989-de23-4644-a4d6-eef04347705d",
          "title": "Core 权限与审批",
          "subtitle": "规划中 · 最终检查由 Core 负责",
          "position": {
            "x": 600,
            "y": 140
          },
          "visualStyle": "tool",
          "inputPorts": [
            {
              "id": "165dca54-e365-4a6c-bd37-1a19c38f055a",
              "name": "输入",
              "side": "left"
            },
            {
              "id": "b49263e8-1434-45f7-bf63-98a6349fcafa",
              "name": "输入",
              "side": "bottom"
            }
          ],
          "outputPorts": [
            {
              "id": "c1e909fc-e24c-4d46-b0aa-b40d749462f0",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "c0a78475-ad60-451a-b46f-c6da5713793d",
          "title": "Debian Shell",
          "subtitle": "规划中 · 未提供执行环境",
          "position": {
            "x": 900,
            "y": 140
          },
          "visualStyle": "tool",
          "inputPorts": [
            {
              "id": "08e9067a-7c1d-4a9a-9bca-31abe4f96c8b",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "c9693aa2-5e0c-4aac-a037-b8fe8a6452f2",
              "name": "输出",
              "side": "right"
            }
          ]
        },
        {
          "id": "29838628-e675-4949-abf9-56eeac00bce1",
          "title": "执行结果",
          "subtitle": "规划中 · 返回模型",
          "position": {
            "x": 1200,
            "y": 140
          },
          "visualStyle": "output",
          "inputPorts": [
            {
              "id": "c9e3c98f-c773-4360-bcc1-89aabf90b7e7",
              "name": "输入",
              "side": "left"
            }
          ],
          "outputPorts": [
            {
              "id": "b01d7318-de62-4ca6-8dda-cee3df1ef9b0",
              "name": "输出"
            }
          ]
        }
      ],
      "edges": [
        {
          "id": "52b00eec-e870-46a9-8482-ca6b0e1b3d92",
          "fromNodeId": "2677e3f8-e3a0-495d-b38b-c9fa2f3ee454",
          "fromPortId": "ea11d456-f647-4c4b-a1b1-6c74db0fe0f3",
          "toNodeId": "a9604226-2a68-4a54-9504-f64badaacdba",
          "toPortId": "e2b66b05-1212-408e-936f-c87f815b15d9",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "trigger"
        },
        {
          "id": "258f86bc-41ed-4ce8-a8ed-694f3b4388e0",
          "fromNodeId": "a9604226-2a68-4a54-9504-f64badaacdba",
          "fromPortId": "e482222d-eec9-40bf-9765-f5a7b7b612d7",
          "toNodeId": "095a6989-de23-4644-a4d6-eef04347705d",
          "toPortId": "165dca54-e365-4a6c-bd37-1a19c38f055a",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "trigger"
        },
        {
          "id": "4d9cb098-a802-4f62-8985-fde556ef2ec4",
          "fromNodeId": "aea482ee-8f91-4854-8aef-94837a570741",
          "fromPortId": "f7935fab-cef0-4048-9030-19f379298f66",
          "toNodeId": "095a6989-de23-4644-a4d6-eef04347705d",
          "toPortId": "b49263e8-1434-45f7-bf63-98a6349fcafa",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "orthogonal"
          },
          "semantic": "data"
        },
        {
          "id": "3ce926fd-2a83-4e53-89c8-a4ca36f7de81",
          "fromNodeId": "ba8b44ae-737e-4ffd-a45c-8744ef876205",
          "fromPortId": "0fe7ca18-5554-4d4d-b1c0-4cadedce4500",
          "toNodeId": "095a6989-de23-4644-a4d6-eef04347705d",
          "toPortId": "b49263e8-1434-45f7-bf63-98a6349fcafa",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "bezier"
          },
          "semantic": "optional"
        },
        {
          "id": "c5ebf901-71d0-44dc-b344-01a55efbc32a",
          "fromNodeId": "095a6989-de23-4644-a4d6-eef04347705d",
          "fromPortId": "c1e909fc-e24c-4d46-b0aa-b40d749462f0",
          "toNodeId": "c0a78475-ad60-451a-b46f-c6da5713793d",
          "toPortId": "08e9067a-7c1d-4a9a-9bca-31abe4f96c8b",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "trigger"
        },
        {
          "id": "20c0d4f8-802f-4fba-8ba9-98981ad91c31",
          "fromNodeId": "c0a78475-ad60-451a-b46f-c6da5713793d",
          "fromPortId": "c9693aa2-5e0c-4aac-a037-b8fe8a6452f2",
          "toNodeId": "29838628-e675-4949-abf9-56eeac00bce1",
          "toPortId": "c9e3c98f-c773-4360-bcc1-89aabf90b7e7",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "bezier"
          },
          "semantic": "feedback"
        },
        {
          "id": "75389207-5f26-438a-85cf-3c693ce3b02b",
          "fromNodeId": "a9604226-2a68-4a54-9504-f64badaacdba",
          "fromPortId": "9c791488-dc2d-4854-992d-5c94990e3d00",
          "toNodeId": "aea482ee-8f91-4854-8aef-94837a570741",
          "toPortId": "098f65b6-7c0b-4f0a-9af6-75e51849040f",
          "appearance": {
            "lineStyle": "solid",
            "pathStyle": "orthogonal"
          },
          "semantic": "data"
        },
        {
          "id": "332b374a-8fd3-40e5-a340-999bc4713bc0",
          "fromNodeId": "aea482ee-8f91-4854-8aef-94837a570741",
          "fromPortId": "f9bdb7b5-6b36-4593-b89a-b23508a2e271",
          "toNodeId": "ba8b44ae-737e-4ffd-a45c-8744ef876205",
          "toPortId": "d67df945-68df-4e59-b054-baab66f068a3",
          "appearance": {
            "lineStyle": "dashed",
            "pathStyle": "orthogonal"
          },
          "semantic": "optional"
        }
      ],
      "viewport": null
    }
  ]
};
